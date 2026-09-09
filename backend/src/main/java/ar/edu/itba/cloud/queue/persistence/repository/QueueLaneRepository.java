package ar.edu.itba.cloud.queue.persistence.repository;

import ar.edu.itba.cloud.queue.persistence.entity.QueueLane;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface QueueLaneRepository extends JpaRepository<QueueLane, UUID> {
    /*
     * Every finder here excludes soft-deleted lanes on purpose, and the unfiltered versions were
     * removed rather than left alongside them: a retired lane must not reappear in the board, the
     * settings list, the public view, the round robin, or party-size matching, and the surest way
     * to guarantee that is to make reading one a compile error. A future metrics query that wants
     * history should add its own explicitly-named finder.
     */
    List<QueueLane> findAllByQueueIdAndDeletedAtIsNullOrderByPriorityAscMinPartySizeAsc(UUID queueId);
    Optional<QueueLane> findByQueueIdAndNameAndDeletedAtIsNull(UUID queueId, String name);
    @Query("select lane from QueueLane lane join fetch lane.queue where lane.id = :id")
    Optional<QueueLane> findByIdWithQueue(@Param("id") UUID id);
    long countByIdAndQueueId(UUID id, UUID queueId);
}
