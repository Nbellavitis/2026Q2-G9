// Empaqueta cada handler de src/handlers/ en un único archivo dist/<nombre>/index.mjs, que es lo que
// Terraform zipea y sube. Una función por archivo: agregar una función es agregar un handler.
import { build } from 'esbuild'
import { readdir, rm } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const handlersDir = 'src/handlers'
const handlers = (await readdir(handlersDir)).filter((file) => extname(file) === '.ts')

await rm('dist', { recursive: true, force: true })

await Promise.all(
  handlers.map((file) =>
    build({
      entryPoints: [`${handlersDir}/${file}`],
      outfile: `dist/${basename(file, '.ts')}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      // El runtime de Lambda ya trae el SDK v3 de AWS: no hace falta empaquetarlo.
      external: ['@aws-sdk/*'],
      // Sin minificar: los errores en CloudWatch se leen con los nombres reales.
      minify: false,
      sourcemap: false,
      logLevel: 'info',
    }),
  ),
)
