// @vitest-environment node
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import { createRuntimeServices } from "./runtime-services";
import {
	FXTWITTER_ORIGIN,
	assertFxTwitterCapability,
	getTweetByIdViaFxTwitterEffect,
	importConversationViaFxTwitterEffect,
	importProfileViaFxTwitterEffect,
	importSearchViaFxTwitterEffect,
	importThreadViaFxTwitterEffect,
	importTweetsViaFxTwitterEffect,
	parseFxTwitterHandle,
	parseFxTwitterSearchQuery,
	parseFxTwitterTweetId,
} from "./fxtwitter";

const testHome = useTestHome({ prefix: "birdclaw-fxtwitter-" });

function fxResponse(status: Record<string, unknown>, code = 200) {
	return new Response(JSON.stringify({ status, code }), {
		status: code,
		headers: { "content-type": "application/json" },
	});
}

function fixture(name: string) {
	return JSON.parse(
		readFileSync(
			new URL(`../test/fixtures/fxtwitter/${name}.json`, import.meta.url),
			"utf8",
		),
	) as Record<string, unknown>;
}

function jsonResponse(
	body: Record<string, unknown>,
	status = Number(body.code ?? 200),
	headers: Record<string, string> = {},
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function fixtureStatus(id = "20") {
	return {
		type: "status",
		id,
		text: "public tweet",
		created_at: "Tue Mar 21 20:50:14 +0000 2006",
		replies: 3,
		reposts: 4,
		likes: 5,
		bookmarks: 6,
		quotes: 7,
		views: 8,
		replying_to: { status: "10", user_id: "34" },
		author: {
			type: "profile",
			id: "12",
			screen_name: "jack",
			name: "Jack",
			description: "public profile",
			location: "",
			avatar_url: "https://pbs.twimg.com/profile_images/12/avatar_200x200.jpg",
			followers: 100,
			following: 2,
			statuses: 50,
			joined: "Tue Mar 21 20:50:14 +0000 2006",
			verification: { verified: true, type: "individual" },
		},
		media: {
			all: [
				{
					type: "photo",
					id: "99",
					url: "https://pbs.twimg.com/media/example.jpg?name=orig",
					width: 1200,
					height: 800,
				},
				{
					type: "photo",
					id: "100",
					url: "https://attacker.example/private.jpg",
				},
			],
		},
		quote: {
			type: "status",
			id: "56",
			text: "quoted public tweet",
			created_at: "Wed Mar 22 20:50:14 +0000 2006",
			author: {
				type: "profile",
				id: "34",
				screen_name: "quoted",
				name: "Quoted",
			},
			media: {},
		},
	};
}

describe("FxTwitter public tweet transport", () => {
	it("accepts only numeric IDs and canonical public status URLs", () => {
		expect(parseFxTwitterTweetId("20")).toBe("20");
		expect(parseFxTwitterTweetId("https://x.com/jack/status/20")).toBe("20");
		expect(
			parseFxTwitterTweetId("https://www.twitter.com/jack/status/20/"),
		).toBe("20");

		for (const unsafe of [
			"1",
			"https://api.fxtwitter.com/2/status/20",
			"http://x.com/jack/status/20",
			"https://x.com@127.0.0.1/jack/status/20",
			"https://x.com/jack/status/20?endpoint=http://127.0.0.1",
			"https://x.com/i/web/status/20",
		]) {
			expect(() => parseFxTwitterTweetId(unsafe)).toThrow(
				/canonical|only a tweet ID/,
			);
		}
	});

	it("validates public capabilities, handles, and queries before network access", () => {
		expect(parseFxTwitterHandle("@Example_1")).toBe("Example_1");
		expect(parseFxTwitterSearchQuery(" local first ")).toBe("local first");
		expect(() => parseFxTwitterHandle("https://example.com/user")).toThrow(
			/public @handle/,
		);
		expect(() => parseFxTwitterSearchQuery("\n")).toThrow(/non-empty query/);
		expect(() => assertFxTwitterCapability("dms")).toThrow(
			expect.objectContaining({ kind: "capability_rejected" }),
		);
	});

	it("uses the fixed endpoint, rejects redirects, and marks normalized rows", async () => {
		const fetch = vi.fn().mockResolvedValue(fxResponse(fixtureStatus()));
		const result = await Effect.runPromise(
			getTweetByIdViaFxTwitterEffect(
				"https://x.com/jack/status/20",
				createRuntimeServices({ fetch }),
			),
		);

		expect(fetch).toHaveBeenCalledOnce();
		const [requestedUrl, requestInit] = fetch.mock.calls[0] ?? [];
		expect(String(requestedUrl)).toBe(`${FXTWITTER_ORIGIN}/2/status/20`);
		expect(requestInit).toMatchObject({
			method: "GET",
			headers: {
				Accept: "application/json",
			},
			redirect: "manual",
		});
		expect((requestInit as RequestInit).headers).toMatchObject({
			"User-Agent": expect.stringMatching(
				/^birdclaw\/\d+[.]\d+[.]\d+ \(fxtwitter-read-only\)$/,
			),
		});
		expect((requestInit as RequestInit).signal).toBeTruthy();
		expect(result.payload).toMatchObject({
			data: [
				{
					id: "20",
					author_id: "12",
					text: "public tweet",
					referenced_tweets: [
						{ type: "replied_to", id: "10" },
						{ type: "quoted", id: "56" },
					],
					public_metrics: { like_count: 5, impression_count: 8 },
				},
			],
			includes: {
				tweets: [{ id: "56", author_id: "34" }],
				users: [{ id: "12", username: "jack" }, { id: "34" }],
				media: [
					{
						media_key: "fxtwitter:20:99",
						url: "https://pbs.twimg.com/media/example.jpg?name=orig",
					},
				],
			},
			meta: {
				source: "fxtwitter",
				endpoint: FXTWITTER_ORIGIN,
				read_only: true,
			},
		});
		expect([...result.provenance.entries()]).toEqual([
			["56", `${FXTWITTER_ORIGIN}/2/status/20`],
			["20", `${FXTWITTER_ORIGIN}/2/status/20`],
		]);
	});

	it("imports clean-but-truncated thread and conversation fixtures as partial", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("thread-truncated")))
			.mockResolvedValueOnce(jsonResponse(fixture("conversation-truncated")));
		const runtime = createRuntimeServices({
			fetch,
			now: () => new Date("2026-08-02T20:00:00.000Z"),
		});

		const thread = await Effect.runPromise(
			importThreadViaFxTwitterEffect("100", {}, runtime),
		);
		const conversation = await Effect.runPromise(
			importConversationViaFxTwitterEffect("100", {}, runtime),
		);

		expect(thread.collection).toMatchObject({
			state: "partial",
			partialReasons: ["endpoint_has_no_exhaustion_proof"],
			pagesFetched: 1,
			itemsObserved: 2,
			upstreamCount: 9,
		});
		expect(conversation.collection).toMatchObject({
			state: "partial",
			partialReasons: ["endpoint_has_no_exhaustion_proof"],
			itemsObserved: 2,
			nextCursor: "conversation-next",
		});
		expect(
			testHome().db.prepare("select id from tweets order by id").all(),
		).toEqual([{ id: "100" }, { id: "101" }, { id: "102" }]);
		expect(
			testHome()
				.db.prepare(
					"select endpoint_family, collection_state, partial_reasons_json from fxtwitter_fetches order by endpoint_family",
				)
				.all(),
		).toEqual([
			{
				endpoint_family: "conversation",
				collection_state: "partial",
				partial_reasons_json: '["endpoint_has_no_exhaustion_proof"]',
			},
			{
				endpoint_family: "thread",
				collection_state: "partial",
				partial_reasons_json: '["endpoint_has_no_exhaustion_proof"]',
			},
		]);
	});

	it("imports a fixture-backed public profile with durable provenance", async () => {
		const runtime = createRuntimeServices({
			fetch: vi.fn().mockResolvedValue(jsonResponse(fixture("profile"))),
			now: () => new Date("2026-08-02T20:01:00.000Z"),
		});
		const result = await Effect.runPromise(
			importProfileViaFxTwitterEffect("@example", runtime),
		);

		expect(result).toMatchObject({
			endpointFamily: "profile",
			request: "example",
			itemsObserved: 1,
			profile: {
				handle: "example",
				displayName: "Example Person",
				followersCount: 123,
			},
		});
		expect(
			testHome()
				.db.prepare(
					"select endpoint_family, request_key, item_kind, item_id from fxtwitter_observations",
				)
				.get(),
		).toEqual({
			endpoint_family: "profile",
			request_key: "example",
			item_kind: "profile",
			item_id: "profile_user_12",
		});
	});

	it("follows a fixture-backed search cursor to proven exhaustion", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-1")))
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-terminal")));
		const result = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"local first",
				{ limit: 10, maxPages: 3 },
				createRuntimeServices({
					fetch,
					now: () => new Date("2026-08-02T20:02:00.000Z"),
				}),
			),
		);

		expect(result.collection).toEqual({
			state: "complete",
			partialReasons: [],
			pagesFetched: 2,
			itemsObserved: 3,
			retrievedAt: "2026-08-02T20:02:00.000Z",
			terminalCursor: "cursor-2",
			nextCursor: undefined,
			interruption: undefined,
		});
		expect(result.tweetIds).toEqual(["200", "201", "202"]);
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				search: expect.stringContaining("cursor=cursor-2"),
			}),
			expect.anything(),
		);
		expect(
			testHome()
				.db.prepare(
					"select item_id from fxtwitter_observations where endpoint_family = 'search' order by item_id",
				)
				.all(),
		).toEqual([{ item_id: "200" }, { item_id: "201" }, { item_id: "202" }]);
	});

	it("fails closed on repeated search cursors while preserving valid items", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-1")))
			.mockResolvedValueOnce(jsonResponse(fixture("search-cursor-cycle")));
		const result = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"cursor test",
				{ limit: 10, maxPages: 3 },
				createRuntimeServices({ fetch }),
			),
		);

		expect(result.collection).toMatchObject({
			state: "partial",
			partialReasons: ["cursor_repeated"],
			pagesFetched: 2,
			itemsObserved: 2,
			nextCursor: "cursor-2",
			interruption: { kind: "cursor_repeated" },
		});
	});

	it("detects a fixture-backed search cursor cycle", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-1")))
			.mockResolvedValueOnce(jsonResponse(fixture("search-cursor-next")))
			.mockResolvedValueOnce(jsonResponse(fixture("search-cursor-cycle")));
		const result = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"cursor cycle",
				{ limit: 10, maxPages: 5 },
				createRuntimeServices({ fetch }),
			),
		);

		expect(result.collection).toMatchObject({
			state: "partial",
			partialReasons: ["cursor_cycle"],
			pagesFetched: 3,
			itemsObserved: 2,
			nextCursor: "cursor-2",
			interruption: { kind: "cursor_cycle" },
		});
	});

	it("records caller and page bounds as partial reasons", async () => {
		const limited = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"bounded limit",
				{ limit: 1, maxPages: 5 },
				createRuntimeServices({
					fetch: vi
						.fn()
						.mockResolvedValue(jsonResponse(fixture("search-page-1"))),
				}),
			),
		);
		const paged = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"bounded pages",
				{ limit: 10, maxPages: 1 },
				createRuntimeServices({
					fetch: vi
						.fn()
						.mockResolvedValue(jsonResponse(fixture("search-page-1"))),
				}),
			),
		);

		expect(limited.collection).toMatchObject({
			state: "partial",
			partialReasons: ["caller_limit"],
			itemsObserved: 1,
			nextCursor: "cursor-2",
		});
		expect(paged.collection).toMatchObject({
			state: "partial",
			partialReasons: ["max_pages"],
			pagesFetched: 1,
			itemsObserved: 2,
			nextCursor: "cursor-2",
		});
	});

	it("returns a typed rate-limit error before any usable result", async () => {
		const fetch = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(
					jsonResponse(fixture("rate-limit"), 429, { "retry-after": "0" }),
				),
			);
		const outcome = await Effect.runPromise(
			Effect.either(
				importSearchViaFxTwitterEffect(
					"rate limit",
					{ limit: 10 },
					createRuntimeServices({ fetch, random: () => 0 }),
				),
			),
		);

		expect(outcome).toEqual(
			expect.objectContaining({
				_tag: "Left",
				left: expect.objectContaining({
					_tag: "FxTwitterError",
					kind: "rate_limited",
					status: 429,
					retryAfterMs: 0,
				}),
			}),
		);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("keeps first-page rows when a later page is rate limited", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-1")))
			.mockImplementation(() =>
				Promise.resolve(
					jsonResponse(fixture("rate-limit"), 429, { "retry-after": "0" }),
				),
			);
		const result = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"partial rate limit",
				{ limit: 10 },
				createRuntimeServices({ fetch, random: () => 0 }),
			),
		);

		expect(result.collection).toMatchObject({
			state: "partial",
			partialReasons: ["rate_limited"],
			pagesFetched: 1,
			itemsObserved: 2,
			nextCursor: "cursor-2",
			interruption: { kind: "rate_limited", status: 429, retryAfterMs: 0 },
		});
		expect(result.tweetIds).toEqual(["200", "201"]);
	});

	it("keeps first-page rows on a fixture-backed mid-pagination upstream failure", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-1")))
			.mockImplementation(() =>
				Promise.resolve(jsonResponse(fixture("upstream-error"), 500)),
			);
		const result = await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"partial upstream",
				{ limit: 10 },
				createRuntimeServices({ fetch, random: () => 0 }),
			),
		);

		expect(result.collection).toMatchObject({
			state: "partial",
			partialReasons: ["upstream_error"],
			pagesFetched: 1,
			itemsObserved: 2,
			nextCursor: "cursor-2",
			interruption: { kind: "http_status", status: 500 },
		});
		expect(result.tweetIds).toEqual(["200", "201"]);
	});

	it("keeps persistence monotonic across a later smaller partial search", async () => {
		const completeFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-1")))
			.mockResolvedValueOnce(jsonResponse(fixture("search-page-terminal")));
		await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"monotonic",
				{ limit: 10 },
				createRuntimeServices({
					fetch: completeFetch,
					now: () => new Date("2026-08-02T20:03:00.000Z"),
				}),
			),
		);
		await Effect.runPromise(
			importSearchViaFxTwitterEffect(
				"monotonic",
				{ limit: 1 },
				createRuntimeServices({
					fetch: vi
						.fn()
						.mockResolvedValue(jsonResponse(fixture("search-page-1"))),
					now: () => new Date("2026-08-02T20:04:00.000Z"),
				}),
			),
		);

		expect(
			testHome().db.prepare("select id from tweets order by id").all(),
		).toEqual([{ id: "200" }, { id: "201" }, { id: "202" }]);
		expect(
			testHome()
				.db.prepare(
					"select item_id from fxtwitter_observations where endpoint_family = 'search' order by item_id",
				)
				.all(),
		).toEqual([{ item_id: "200" }, { item_id: "201" }, { item_id: "202" }]);
		expect(
			testHome()
				.db.prepare(
					"select collection_state from fxtwitter_fetches order by retrieved_at",
				)
				.all(),
		).toEqual([
			{ collection_state: "complete" },
			{ collection_state: "partial" },
		]);
	});

	it("validates all inputs before making any request", async () => {
		const fetch = vi.fn();
		await expect(
			Effect.runPromise(
				importTweetsViaFxTwitterEffect(
					["20", "https://private.example/status/30"],
					createRuntimeServices({ fetch }),
				),
			),
		).rejects.toThrow(/only a tweet ID/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects unavailable, mismatched, and oversized responses", async () => {
		const unavailable = createRuntimeServices({
			fetch: vi
				.fn()
				.mockResolvedValue(
					fxResponse(
						{ type: "tombstone", id: "20", reason: "unavailable" },
						404,
					),
				),
		});
		await expect(
			Effect.runPromise(getTweetByIdViaFxTwitterEffect("20", unavailable)),
		).rejects.toThrow(/status 404/);

		const mismatched = createRuntimeServices({
			fetch: vi.fn().mockResolvedValue(fxResponse(fixtureStatus("21"))),
		});
		await expect(
			Effect.runPromise(getTweetByIdViaFxTwitterEffect("20", mismatched)),
		).rejects.toThrow(/returned tweet 21/);

		const oversized = createRuntimeServices({
			fetch: vi.fn().mockResolvedValue(
				new Response("{}", {
					headers: { "content-length": String(2 * 1024 * 1024 + 1) },
				}),
			),
		});
		await expect(
			Effect.runPromise(getTweetByIdViaFxTwitterEffect("20", oversized)),
		).rejects.toThrow(/too large/);
	});

	it("persists canonical tweets with durable FxTwitter provenance", async () => {
		const fetch = vi.fn().mockResolvedValue(fxResponse(fixtureStatus()));
		const result = await Effect.runPromise(
			importTweetsViaFxTwitterEffect(["20"], createRuntimeServices({ fetch })),
		);

		expect(result).toMatchObject({
			ok: true,
			readOnlyTransport: true,
			source: "fxtwitter",
			endpoint: FXTWITTER_ORIGIN,
			requestedCount: 1,
			importedCount: 1,
			items: [
				{
					tweetId: "20",
					source: "fxtwitter",
					sourceUrl: `${FXTWITTER_ORIGIN}/2/status/20`,
				},
			],
		});
		expect(
			testHome()
				.db.prepare(
					"select tweet_id, source, source_url from tweet_sources order by tweet_id",
				)
				.all(),
		).toEqual([
			{
				tweet_id: "20",
				source: "fxtwitter",
				source_url: `${FXTWITTER_ORIGIN}/2/status/20`,
			},
			{
				tweet_id: "56",
				source: "fxtwitter",
				source_url: `${FXTWITTER_ORIGIN}/2/status/20`,
			},
		]);
		expect(
			testHome().db.prepare("select id, text from tweets order by id").all(),
		).toEqual([
			{ id: "20", text: "public tweet" },
			{ id: "56", text: "quoted public tweet" },
		]);
	});
});
