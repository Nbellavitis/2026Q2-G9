#!/usr/bin/env bash
# Crea y borra los buckets de la aplicación por fuera de Terraform.
#
# Por qué existe: después de crear un bucket con `aws_s3_bucket`, el provider lee su configuración de
# object lock, y el SCP del Learner Lab niega `s3:GetBucketObjectLockConfiguration` con un deny
# explícito. Ninguna versión del provider tolera ese AccessDenied (v4.67, v5.100 y v6.67 lo tratan
# como error en la partición `aws`), y la lectura es incondicional. Las demás lecturas de S3 están
# permitidas, así que Terraform sigue administrando todo lo que va sobre cada bucket (módulo
# private-bucket): acceso público, propiedad de los objetos, versionado, política, registros de
# acceso, expiración y contenido. Esto solo los crea y, al destruir, los vacía y los borra.
#
# Los nombres los decide Terraform (output `bucket_names`); acá no se repite la regla. Se anotan en el
# bucket del estado antes de crear nada, así `delete` los encuentra aunque un apply se corte después
# de crearlos y antes de escribir sus outputs.
#
#   buckets.sh create <bucket-del-estado> <nombre>...   en el orden en que se van a borrar
#   buckets.sh delete <bucket-del-estado>

set -euo pipefail

RECORD_KEY="queue/buckets.txt"

exists() {
  aws s3api head-bucket --bucket "$1" >/dev/null 2>&1
}

create() {
  local state_bucket=$1
  shift
  [ "$#" -gt 0 ] || { echo "No hay buckets para crear: el plan no trajo bucket_names" >&2; exit 1; }

  printf '%s\n' "$@" | aws s3 cp - "s3://${state_bucket}/${RECORD_KEY}" --no-progress >/dev/null
  echo "Anotados en s3://${state_bucket}/${RECORD_KEY}"

  local name
  for name in "$@"; do
    if exists "$name"; then
      echo "Ya existe: $name"
      continue
    fi
    echo "Creando: $name"
    # En us-east-1 no se manda LocationConstraint; en cualquier otra región es obligatorio.
    if [ "${AWS_REGION}" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$name" >/dev/null
    else
      aws s3api create-bucket --bucket "$name" \
        --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
    fi
    aws s3api wait bucket-exists --bucket "$name"
  done
}

# Borra todas las versiones y marcas de borrado, de a 1000 (el máximo de delete-objects).
empty() {
  local name=$1 listing batch count
  while :; do
    listing=$(aws s3api list-object-versions --bucket "$name" --max-items 1000 --output json)
    # Un bucket vacío puede no devolver nada: se toma como un listado sin objetos.
    [ -n "$listing" ] || listing='{}'
    batch=$(jq -c '{Objects: ([(.Versions // [])[], (.DeleteMarkers // [])[]] | map({Key, VersionId})), Quiet: true}' \
      <<<"$listing")
    count=$(jq '.Objects | length' <<<"$batch")
    [ "$count" -gt 0 ] || return 0
    aws s3api delete-objects --bucket "$name" --delete "$batch" >/dev/null
  done
}

delete() {
  local state_bucket=$1 record name attempt
  local -a names
  if ! record=$(aws s3 cp "s3://${state_bucket}/${RECORD_KEY}" - 2>/dev/null); then
    echo "No hay buckets anotados en s3://${state_bucket}/${RECORD_KEY}: nada que borrar"
    return 0
  fi
  mapfile -t names <<<"$record"

  for name in "${names[@]}"; do
    [ -n "$name" ] || continue
    if ! exists "$name"; then
      echo "Ya no existe: $name"
      continue
    fi
    echo "Vaciando y borrando: $name"
    # S3 entrega los registros de acceso con minutos de atraso: alguno puede llegar al bucket de logs
    # entre que se vacía y se borra. Se reintenta en lugar de fallar.
    for attempt in 1 2 3 4 5 6; do
      empty "$name"
      if aws s3api delete-bucket --bucket "$name" 2>/dev/null; then break; fi
      if [ "$attempt" -eq 6 ]; then echo "No se pudo borrar $name" >&2; exit 1; fi
      sleep 10
    done
  done

  aws s3 rm "s3://${state_bucket}/${RECORD_KEY}" --only-show-errors
}

case "${1:-}" in
  create) shift; create "$@" ;;
  delete) shift; delete "$@" ;;
  *) echo "Uso: $0 create <bucket-del-estado> <nombre>... | delete <bucket-del-estado>" >&2; exit 2 ;;
esac
