import { createHash } from "node:crypto";
import type { Database } from "./sqlite";

export type FxTwitterEndpointFamily =
	| "status"
	| "thread"
	| "conversation"
	| "profile"
	| "search";

export type FxTwitterCollectionState = "complete" | "partial";

export type FxTwitterPartialReason =
	| "endpoint_has_no_exhaustion_proof"
	| "caller_limit"
	| "max_pages"
	| "timeout"
	| "rate_limited"
	| "upstream_error"
	| "decode_error"
	| "cursor_missing_or_malformed"
	| "cursor_repeated"
	| "cursor_cycle";

export interface FxTwitterFailureSummary {
	kind: string;
	message: string;
	status?: number;
	retryAfterMs?: number;
}

export interface FxTwitterCollectionMetadata {
	state: FxTwitterCollectionState;
	partialReasons: FxTwitterPartialReason[];
	pagesFetched: number;
	itemsObserved: number;
	retrievedAt: string;
	terminalCursor: string | null;
	nextCursor?: string;
	upstreamCount?: number;
	interruption?: FxTwitterFailureSummary;
}

export interface FxTwitterPersistedFetch {
	endpointFamily: FxTwitterEndpointFamily;
	requestKey: string;
	sourceUrl: string;
	retrievedAt: string;
	pagesFetched: number;
	itemsObserved: number;
	collection?: FxTwitterCollectionMetadata;
	items: ReadonlyArray<{ kind: "tweet" | "profile"; id: string }>;
}

function fetchIdFor(fetch: FxTwitterPersistedFetch) {
	const stable = JSON.stringify({
		endpointFamily: fetch.endpointFamily,
		requestKey: fetch.requestKey,
		sourceUrl: fetch.sourceUrl,
		retrievedAt: fetch.retrievedAt,
		pagesFetched: fetch.pagesFetched,
		itemsObserved: fetch.itemsObserved,
		collection: fetch.collection,
		items: [...fetch.items].sort((left, right) =>
			`${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
		),
	});
	return createHash("sha256").update(stable).digest("hex");
}

export function recordFxTwitterFetch(
	db: Database,
	fetch: FxTwitterPersistedFetch,
) {
	const fetchId = fetchIdFor(fetch);
	const collection = fetch.collection;
	db.transaction(() => {
		db.prepare(
			`
        insert into fxtwitter_fetches (
          id, endpoint_family, request_key, source_url, retrieved_at,
          collection_state, partial_reasons_json, pages_fetched, items_observed,
          terminal_cursor, next_cursor, upstream_count, failure_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do nothing
        `,
		).run(
			fetchId,
			fetch.endpointFamily,
			fetch.requestKey,
			fetch.sourceUrl,
			fetch.retrievedAt,
			collection?.state ?? null,
			JSON.stringify(collection?.partialReasons ?? []),
			fetch.pagesFetched,
			fetch.itemsObserved,
			collection?.terminalCursor ?? null,
			collection?.nextCursor ?? null,
			collection?.upstreamCount ?? null,
			collection?.interruption ? JSON.stringify(collection.interruption) : null,
		);

		const upsertObservation = db.prepare(`
      insert into fxtwitter_observations (
        endpoint_family, request_key, item_kind, item_id, source_url,
        first_seen_at, last_seen_at, seen_count, last_fetch_id
      ) values (?, ?, ?, ?, ?, ?, ?, 1, ?)
      on conflict(endpoint_family, request_key, item_kind, item_id) do update set
        source_url = case
          when excluded.last_seen_at >= fxtwitter_observations.last_seen_at
            then excluded.source_url
          else fxtwitter_observations.source_url
        end,
        first_seen_at = min(fxtwitter_observations.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(fxtwitter_observations.last_seen_at, excluded.last_seen_at),
        seen_count = fxtwitter_observations.seen_count +
          case when excluded.last_fetch_id = fxtwitter_observations.last_fetch_id then 0 else 1 end,
        last_fetch_id = case
          when excluded.last_seen_at >= fxtwitter_observations.last_seen_at
            then excluded.last_fetch_id
          else fxtwitter_observations.last_fetch_id
        end
    `);
		for (const item of fetch.items) {
			upsertObservation.run(
				fetch.endpointFamily,
				fetch.requestKey,
				item.kind,
				item.id,
				fetch.sourceUrl,
				fetch.retrievedAt,
				fetch.retrievedAt,
				fetchId,
			);
		}
	})();
	return fetchId;
}
