package ar.edu.itba.cloud.queue.integration;

import static org.assertj.core.api.Assertions.assertThat;

import ar.edu.itba.cloud.queue.persistence.entity.EntryStatus;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Retiring a lane.
 *
 * <p>A lane cannot be removed from the database once it has held anyone: {@code queue_entry.lane_id}
 * is NOT NULL and references it, so even a customer served last week pins the row. The delete guard
 * only counted <em>active</em> entries, so the call passed its own check and then failed on the
 * foreign key as an unmapped 500 - for the single most ordinary case there is, a lane that has been
 * used. It is now a soft delete, which also keeps the band each finished customer was served in.
 */
@DisplayName("Retiring a lane")
class LaneRetirementIntegrationTest extends AbstractIntegrationTest {

    @Test
    @DisplayName("a lane that has already served someone can be retired, and its history survives")
    void retiresAfterUse() throws Exception {
        Account owner = registerOwner("owner@retire.q", "Parrilla La Espera");
        UUID queueId = createQueue(owner, "Mesas", Map.of("serviceStations", 1, "defaultServiceMinutes", 10));
        UUID laneId = createLane(owner, queueId, "Grupos grandes", 5);

        JsonNode ticket = joinWithParty(queueId, "Grupo Grande", "grande@retire.q", 6);
        assertThat(ticket.get("laneId").asText()).isEqualTo(laneId.toString());

        UUID entryId = UUID.fromString(callNext(owner, queueId).get("id").asText());
        setEntryStatus(owner, entryId, EntryStatus.SERVED);

        // The case that used to be a 500.
        doDelete("/api/v1/queues/%s/lanes/%s".formatted(queueId, laneId), owner.token(), 204);

        // Gone from every surface an operator or customer can see...
        assertThat(laneNames(owner, queueId)).containsExactly("1+");
        assertThat(board(owner, queueId).get("lanes")).noneMatch(l -> l.get("lane").get("id").asText().equals(laneId.toString()));
        assertThat(doGet("/api/v1/public/queues/" + queueId, null, 200).get("lanes"))
                .noneMatch(l -> l.get("id").asText().equals(laneId.toString()));

        // ...but the served customer still records which band they were in, which is the whole
        // reason the row is kept rather than deleted.
        assertThat(readTicket(ticketToken(ticket)).get("laneName").asText()).isEqualTo("Grupos grandes");
    }

    @Test
    @DisplayName("the retired name is free again, so the same line can be recreated")
    void freesItsName() throws Exception {
        Account owner = registerOwner("owner@rename.q", "Parrilla La Espera");
        UUID queueId = createQueue(owner, "Mesas", Map.of("serviceStations", 1, "defaultServiceMinutes", 10));
        UUID laneId = createLane(owner, queueId, "Grupos grandes", 5);

        // Name uniqueness is a partial index over live rows only. Without that, retiring a lane
        // would burn its name for the lifetime of the queue and recreating it would fail on the
        // constraint - trading the old 500 for a new one.
        doDelete("/api/v1/queues/%s/lanes/%s".formatted(queueId, laneId), owner.token(), 204);
        UUID recreated = createLane(owner, queueId, "Grupos grandes", 5);

        assertThat(recreated).isNotEqualTo(laneId);
        assertThat(laneNames(owner, queueId)).containsExactlyInAnyOrder("1+", "Grupos grandes");
    }

    @Test
    @DisplayName("two live lines cannot share a name, and it is a conflict rather than a server error")
    void rejectsDuplicateLiveName() throws Exception {
        Account owner = registerOwner("owner@dup.q", "Parrilla La Espera");
        UUID queueId = createQueue(owner, "Mesas", Map.of("serviceStations", 1, "defaultServiceMinutes", 10));
        createLane(owner, queueId, "Grupos grandes", 5);

        Map<String, Object> duplicate = new HashMap<>();
        duplicate.put("name", "Grupos grandes");
        duplicate.put("minPartySize", 8);
        duplicate.put("maxPartySize", null);
        duplicate.put("priority", 2);
        duplicate.put("capacityMode", "GROUPS");
        duplicate.put("maxSize", null);
        duplicate.put("timeFactor", 1.0);
        duplicate.put("active", true);

        JsonNode problem = doPost("/api/v1/queues/%s/lanes".formatted(queueId), duplicate, owner.token(), 409);
        assertThat(problem.get("code").asText()).isEqualTo("LANE_NAME_TAKEN");
    }

    @Test
    @DisplayName("a lane people are still waiting in cannot be retired")
    void refusesWhileOccupied() throws Exception {
        Account owner = registerOwner("owner@occupied.q", "Parrilla La Espera");
        UUID queueId = createQueue(owner, "Mesas", Map.of("serviceStations", 1, "defaultServiceMinutes", 10));
        UUID laneId = createLane(owner, queueId, "Grupos grandes", 5);
        joinWithParty(queueId, "Sigue Esperando", "espera@occupied.q", 6);

        JsonNode problem = doDelete("/api/v1/queues/%s/lanes/%s".formatted(queueId, laneId), owner.token(), 409);
        assertThat(problem.get("code").asText()).isEqualTo("LANE_HAS_ACTIVE_ENTRIES");
    }

    @Test
    @DisplayName("someone whose lane was retired can still be put back in the line and called")
    void requeueSurvivesRetirement() throws Exception {
        Account owner = registerOwner("owner@requeue.q", "Parrilla La Espera");
        UUID queueId = createQueue(owner, "Mesas", Map.of("serviceStations", 1, "defaultServiceMinutes", 10));
        UUID laneId = createLane(owner, queueId, "Grupos grandes", 5);

        JsonNode ticket = joinWithParty(queueId, "Vuelve", "vuelve@requeue.q", 6);
        UUID entryId = UUID.fromString(callNext(owner, queueId).get("id").asText());
        setEntryStatus(owner, entryId, EntryStatus.SERVED);
        doDelete("/api/v1/queues/%s/lanes/%s".formatted(queueId, laneId), owner.token(), 204);

        // "Put back" never re-resolves the lane, so there is nothing here that needs the lane to
        // still be selectable - only that the row it points at still exists.
        setEntryStatus(owner, entryId, EntryStatus.WAITING);
        assertThat(readTicket(ticketToken(ticket)).get("status").asText()).isEqualTo("WAITING");

        // And they are still reachable: every call strategy falls through to an age-ordered pick
        // across all waiting entries, regardless of which lane they sit in.
        assertThat(callNext(owner, queueId).get("id").asText()).isEqualTo(entryId.toString());
    }

    private UUID createLane(Account owner, UUID queueId, String name, int minPartySize) throws Exception {
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        body.put("minPartySize", minPartySize);
        body.put("maxPartySize", null);
        body.put("priority", 1);
        body.put("capacityMode", "GROUPS");
        body.put("maxSize", null);
        body.put("timeFactor", 1.5);
        body.put("active", true);
        return UUID.fromString(
                doPost("/api/v1/queues/%s/lanes".formatted(queueId), body, owner.token(), 200).get("id").asText());
    }

    private JsonNode joinWithParty(UUID queueId, String name, String email, int partySize) throws Exception {
        return doPost("/api/v1/public/queues/%s/entries".formatted(queueId),
                Map.of("name", name, "email", email, "partySize", partySize), null, 201);
    }

    private java.util.List<String> laneNames(Account owner, UUID queueId) throws Exception {
        JsonNode lanes = doGet("/api/v1/queues/%s/lanes".formatted(queueId), owner.token(), 200);
        java.util.List<String> names = new java.util.ArrayList<>();
        lanes.forEach(lane -> names.add(lane.get("name").asText()));
        return names;
    }
}
