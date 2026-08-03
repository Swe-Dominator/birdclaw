import { Buffer } from "node:buffer";
import { Data, Effect } from "effect";
import packageManifest from "../../package.json";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	recordFxTwitterFetch,
	type FxTwitterCollectionMetadata,
	type FxTwitterFailureSummary,
	type FxTwitterPartialReason,
} from "./fxtwitter-store";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";
import { ingestTweetPayload } from "./tweet-repository";
import type {
	ProfileRecord,
	XurlMediaItem,
	XurlMentionUser,
	XurlTweetData,
	XurlTweetsResponse,
} from "./types";
import { upsertProfileFromXUser } from "./x-profile";

export const FXTWITTER_ORIGIN = "https://api.fxtwitter.com";

const FXTWITTER_TWEET_ID_PATTERN = /^\d{2,20}$/;
const TWITTER_ENTITY_ID_PATTERN = /^\d{1,20}$/;
const FXTWITTER_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const FXTWITTER_TIMEOUT_MS = 15_000;
const FXTWITTER_TOTAL_DEADLINE_MS = 30_000;
const FXTWITTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FXTWITTER_MAX_TWEETS_PER_IMPORT = 20;
const FXTWITTER_MAX_COLLECTION_ITEMS = 1_000;
const FXTWITTER_MAX_PAGES = 10;
const FXTWITTER_MAX_ATTEMPTS = 3;
const FXTWITTER_MAX_BACKOFF_MS = 2_000;
const TWITTER_STATUS_HOSTS = new Set([
	"twitter.com",
	"www.twitter.com",
	"x.com",
	"www.x.com",
]);
const TWITTER_IMAGE_HOSTS = new Set(["pbs.twimg.com"]);
const TWITTER_VIDEO_HOSTS = new Set(["video.twimg.com"]);
const FXTWITTER_USER_AGENT = `birdclaw/${packageManifest.version} (fxtwitter-read-only)`;

type JsonRecord = Record<string, unknown>;

export type FxTwitterErrorKind =
	| "capability_rejected"
	| "input_rejected"
	| "origin_policy"
	| "network"
	| "timeout"
	| "http_status"
	| "rate_limited"
	| "api_failure"
	| "response_too_large"
	| "decode_error"
	| "not_found"
	| "unavailable"
	| "protected"
	| "cursor_missing_or_malformed"
	| "cursor_repeated"
	| "cursor_cycle";

export class FxTwitterError extends Data.TaggedError("FxTwitterError")<{
	readonly kind: FxTwitterErrorKind;
	readonly message: string;
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;
}> {}

export type FxTwitterCapability =
	| "tweet"
	| "thread"
	| "conversation"
	| "profile"
	| "search";

const FXTWITTER_CAPABILITIES = new Set<FxTwitterCapability>([
	"tweet",
	"thread",
	"conversation",
	"profile",
	"search",
]);

export interface FxTwitterTweet {
	payload: XurlTweetsResponse;
	provenance: ReadonlyMap<string, string>;
}

export interface FxTwitterImportResult {
	ok: true;
	readOnlyTransport: true;
	source: "fxtwitter";
	endpoint: typeof FXTWITTER_ORIGIN;
	requestedCount: number;
	importedCount: number;
	items: Array<{
		tweetId: string;
		source: "fxtwitter";
		sourceUrl: string;
	}>;
}

export interface FxTwitterCollectionImportResult {
	ok: true;
	readOnlyTransport: true;
	source: "fxtwitter";
	endpoint: typeof FXTWITTER_ORIGIN;
	endpointFamily: "thread" | "conversation" | "search";
	request: string;
	importedCount: number;
	tweetIds: string[];
	collection: FxTwitterCollectionMetadata;
}

export interface FxTwitterProfileImportResult {
	ok: true;
	readOnlyTransport: true;
	source: "fxtwitter";
	endpoint: typeof FXTWITTER_ORIGIN;
	endpointFamily: "profile";
	request: string;
	retrievedAt: string;
	pagesFetched: 1;
	itemsObserved: 1;
	profile: ProfileRecord;
}

export interface FxTwitterCollectionOptions {
	limit?: number;
	maxPages?: number;
	feed?: "latest" | "top" | "media";
}

interface NormalizedStatusTree {
	primary: XurlTweetData;
	tweets: Map<string, XurlTweetData>;
	users: Map<string, XurlMentionUser>;
	media: Map<string, XurlMediaItem>;
}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function asCount(value: unknown) {
	return Math.max(0, Math.trunc(asNumber(value) ?? 0));
}

function unique<T>(values: readonly T[]) {
	return [...new Set(values)];
}

function inputError(message: string) {
	return new FxTwitterError({ kind: "input_rejected", message });
}

function decodeError(message: string, cause?: unknown) {
	return new FxTwitterError({ kind: "decode_error", message, cause });
}

function toIsoDate(value: unknown, field: string) {
	const raw = asString(value);
	const timestamp = raw ? Date.parse(raw) : Number.NaN;
	if (!Number.isFinite(timestamp)) {
		throw decodeError(`FxTwitter response has an invalid ${field}`);
	}
	return new Date(timestamp).toISOString();
}

function sourceUrlForTweet(tweetId: string) {
	return `${FXTWITTER_ORIGIN}/2/status/${tweetId}`;
}

function endpointUrl(
	path: string,
	query?: Readonly<Record<string, string | number | undefined>>,
) {
	const url = new URL(path, FXTWITTER_ORIGIN);
	if (url.origin !== FXTWITTER_ORIGIN || url.username || url.password) {
		throw new FxTwitterError({
			kind: "origin_policy",
			message: "FxTwitter requests must use the fixed public origin",
		});
	}
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	return url;
}

export function assertFxTwitterCapability(
	capability: string,
): asserts capability is FxTwitterCapability {
	if (!FXTWITTER_CAPABILITIES.has(capability as FxTwitterCapability)) {
		throw new FxTwitterError({
			kind: "capability_rejected",
			message: `FxTwitter does not support ${capability}; authenticated, private, and write capabilities are unavailable`,
		});
	}
}

export function parseFxTwitterTweetId(value: string) {
	const trimmed = value.trim();
	if (FXTWITTER_TWEET_ID_PATTERN.test(trimmed)) return trimmed;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw inputError(
			`Invalid public tweet ID or canonical x.com/Twitter status URL: ${trimmed}`,
		);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		parsed.search ||
		parsed.hash ||
		!TWITTER_STATUS_HOSTS.has(parsed.hostname.toLowerCase())
	) {
		throw inputError(
			"FxTwitter accepts only a tweet ID or canonical HTTPS x.com/Twitter status URL",
		);
	}
	const match = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{2,20})\/?$/.exec(
		parsed.pathname,
	);
	if (!match?.[1]) {
		throw inputError(
			"FxTwitter accepts only a tweet ID or canonical HTTPS x.com/Twitter status URL",
		);
	}
	return match[1];
}

export function parseFxTwitterHandle(value: string) {
	const handle = value.trim().replace(/^@/, "");
	if (!FXTWITTER_HANDLE_PATTERN.test(handle)) {
		throw inputError("FxTwitter profile lookup requires a public @handle");
	}
	return handle;
}

export function parseFxTwitterSearchQuery(value: string) {
	const query = value.trim();
	if (!query || query.length > 512 || /[\u0000-\u001f\u007f]/u.test(query)) {
		throw inputError(
			"FxTwitter search requires a non-empty query of at most 512 characters",
		);
	}
	return query;
}

function validateLimit(value: number | undefined, fallback: number) {
	const limit = value ?? fallback;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > FXTWITTER_MAX_COLLECTION_ITEMS
	) {
		throw inputError(
			`FxTwitter result limit must be between 1 and ${String(FXTWITTER_MAX_COLLECTION_ITEMS)}`,
		);
	}
	return limit;
}

function validateMaxPages(value: number | undefined) {
	const maxPages = value ?? 5;
	if (
		!Number.isSafeInteger(maxPages) ||
		maxPages < 1 ||
		maxPages > FXTWITTER_MAX_PAGES
	) {
		throw inputError(
			`FxTwitter max pages must be between 1 and ${String(FXTWITTER_MAX_PAGES)}`,
		);
	}
	return maxPages;
}

function safeUrlForHosts(value: unknown, hosts: ReadonlySet<string>) {
	const raw = asString(value);
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.port ||
			!hosts.has(parsed.hostname.toLowerCase())
		) {
			return undefined;
		}
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function safePublicUrl(value: unknown) {
	const raw = asString(value);
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		return parsed.protocol === "https:" && !parsed.username && !parsed.password
			? parsed.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

function normalizeAuthor(value: unknown): XurlMentionUser {
	const author = asRecord(value);
	const id = asString(author?.id);
	const username = asString(author?.screen_name);
	if (!author || !id || !TWITTER_ENTITY_ID_PATTERN.test(id) || !username) {
		throw decodeError("FxTwitter response is missing a valid tweet author");
	}
	const verification = asRecord(author.verification);
	const website = asRecord(author.website);
	const joined = asString(author.joined);
	const joinedTimestamp = joined ? Date.parse(joined) : Number.NaN;
	return {
		id,
		name: asString(author.name) ?? username,
		username,
		description: asString(author.description),
		location: asString(author.location),
		url: safePublicUrl(website?.url),
		verified: Boolean(verification?.verified),
		verified_type: asString(verification?.type),
		profile_image_url: safeUrlForHosts(author.avatar_url, TWITTER_IMAGE_HOSTS),
		public_metrics: {
			followers_count: asCount(author.followers),
			following_count: asCount(author.following),
			tweet_count: asCount(author.statuses),
		},
		created_at: Number.isFinite(joinedTimestamp)
			? new Date(joinedTimestamp).toISOString()
			: undefined,
		protected: Boolean(author.protected),
	};
}

function normalizeMedia(tweetId: string, value: unknown) {
	const media = asRecord(value);
	const items = asArray(media?.all);
	const normalized: XurlMediaItem[] = [];
	for (const [index, rawItem] of items.entries()) {
		const item = asRecord(rawItem);
		const type = asString(item?.type);
		if (!item || !type) continue;
		const providerId = asString(item.id) ?? String(index + 1);
		const mediaKey = `fxtwitter:${tweetId}:${providerId}`;
		if (type === "photo") {
			const url = safeUrlForHosts(item.url, TWITTER_IMAGE_HOSTS);
			if (!url) continue;
			normalized.push({
				media_key: mediaKey,
				type: "photo",
				url,
				width: asNumber(item.width),
				height: asNumber(item.height),
				alt_text: asString(item.altText) ?? asString(item.alt_text),
			});
			continue;
		}
		if (type !== "video" && type !== "gif") continue;
		const previewImageUrl = safeUrlForHosts(
			item.thumbnail_url ?? item.thumbnailUrl ?? item.poster,
			TWITTER_IMAGE_HOSTS,
		);
		const variantRows = [...asArray(item.variants), ...asArray(item.formats)];
		const variants = variantRows.flatMap((rawVariant) => {
			const variant = asRecord(rawVariant);
			const url = safeUrlForHosts(variant?.url, TWITTER_VIDEO_HOSTS);
			if (!variant || !url) return [];
			return [
				{
					url,
					content_type:
						asString(variant.content_type) ??
						asString(variant.contentType) ??
						"video/mp4",
					bit_rate: asNumber(variant.bit_rate) ?? asNumber(variant.bitrate),
				},
			];
		});
		if (!previewImageUrl && variants.length === 0) continue;
		normalized.push({
			media_key: mediaKey,
			type: type === "gif" ? "animated_gif" : "video",
			preview_image_url: previewImageUrl,
			duration_ms: asNumber(item.duration_ms) ?? asNumber(item.durationMillis),
			width: asNumber(item.width),
			height: asNumber(item.height),
			alt_text: asString(item.altText) ?? asString(item.alt_text),
			variants,
		});
	}
	return normalized;
}

function normalizeStatusTree(value: unknown): NormalizedStatusTree {
	const tweets = new Map<string, XurlTweetData>();
	const users = new Map<string, XurlMentionUser>();
	const media = new Map<string, XurlMediaItem>();

	const visit = (candidate: unknown, depth: number): XurlTweetData => {
		const status = asRecord(candidate);
		const id = asString(status?.id);
		if (
			!status ||
			status.type !== "status" ||
			!id ||
			!FXTWITTER_TWEET_ID_PATTERN.test(id)
		) {
			throw decodeError(
				"FxTwitter response does not contain an available public tweet",
			);
		}
		const author = normalizeAuthor(status.author);
		users.set(author.id, author);
		const tweetMedia = normalizeMedia(id, status.media);
		for (const item of tweetMedia) media.set(item.media_key, item);

		const referencedTweets: Array<{ type: string; id: string }> = [];
		const replyingTo = asRecord(status.replying_to);
		const repliedToId = asString(replyingTo?.status);
		if (repliedToId && FXTWITTER_TWEET_ID_PATTERN.test(repliedToId)) {
			referencedTweets.push({ type: "replied_to", id: repliedToId });
		}
		const quote = asRecord(status.quote);
		if (quote?.type === "status" && depth < 2) {
			const quotedTweet = visit(quote, depth + 1);
			referencedTweets.push({ type: "quoted", id: quotedTweet.id });
		}

		const tweet: XurlTweetData = {
			id,
			author_id: author.id,
			text: asString(status.text) ?? "",
			created_at: toIsoDate(status.created_at, "tweet creation date"),
			conversation_id: id,
			in_reply_to_user_id: asString(replyingTo?.user_id),
			attachments:
				tweetMedia.length > 0
					? { media_keys: tweetMedia.map((item) => item.media_key) }
					: undefined,
			referenced_tweets:
				referencedTweets.length > 0 ? referencedTweets : undefined,
			public_metrics: {
				reply_count: asCount(status.replies),
				retweet_count: asCount(status.reposts),
				like_count: asCount(status.likes),
				quote_count: asCount(status.quotes),
				bookmark_count: asCount(status.bookmarks),
				impression_count: asCount(status.views),
			},
		};
		tweets.set(id, tweet);
		return tweet;
	};

	const primary = visit(value, 0);
	return { primary, tweets, users, media };
}

function mergeStatusTrees(trees: readonly NormalizedStatusTree[]) {
	const primary = new Map<string, XurlTweetData>();
	const tweets = new Map<string, XurlTweetData>();
	const users = new Map<string, XurlMentionUser>();
	const media = new Map<string, XurlMediaItem>();
	for (const tree of trees) {
		primary.set(tree.primary.id, tree.primary);
		for (const [id, tweet] of tree.tweets) tweets.set(id, tweet);
		for (const [id, user] of tree.users) users.set(id, user);
		for (const [id, item] of tree.media) media.set(id, item);
	}
	const primaryIds = new Set(primary.keys());
	const payload: XurlTweetsResponse = {
		data: [...primary.values()],
		includes: {
			users: [...users.values()],
			tweets: [...tweets.values()].filter((tweet) => !primaryIds.has(tweet.id)),
			media: [...media.values()],
		},
		meta: {
			source: "fxtwitter",
			endpoint: FXTWITTER_ORIGIN,
			read_only: true,
		},
	};
	return { payload, allTweetIds: [...tweets.keys()] };
}

async function readBoundedJson(response: Response) {
	const contentLength = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(contentLength) &&
		contentLength > FXTWITTER_MAX_RESPONSE_BYTES
	) {
		throw new FxTwitterError({
			kind: "response_too_large",
			message: "FxTwitter response is too large",
		});
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > FXTWITTER_MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new FxTwitterError({
				kind: "response_too_large",
				message: "FxTwitter response is too large",
			});
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch (cause) {
		throw decodeError("FxTwitter returned invalid JSON", cause);
	}
}

function retryAfterMs(response: Response, now: Date) {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? Math.max(0, timestamp - now.getTime())
		: undefined;
}

function statusError(response: Response, root: JsonRecord | null, now: Date) {
	const providerCode = asNumber(root?.code);
	const status = providerCode ?? response.status;
	const message = asString(root?.message) ?? `status ${String(status)}`;
	const reason = asString(root?.reason)?.toLowerCase();
	if (status === 429) {
		return new FxTwitterError({
			kind: "rate_limited",
			message: `FxTwitter rate limited the request: ${message}`,
			status: response.status,
			retryAfterMs: retryAfterMs(response, now),
		});
	}
	if (status === 404) {
		return new FxTwitterError({
			kind: "not_found",
			message: `FxTwitter public object was not found: ${message}`,
			status: response.status,
		});
	}
	if (status === 401 || status === 403 || reason === "protected") {
		return new FxTwitterError({
			kind: reason === "protected" ? "protected" : "unavailable",
			message: `FxTwitter public object is unavailable: ${message}`,
			status: response.status,
		});
	}
	if (status === 410 || reason === "deleted" || reason === "suspended") {
		return new FxTwitterError({
			kind: "unavailable",
			message: `FxTwitter public object is unavailable: ${message}`,
			status: response.status,
		});
	}
	return new FxTwitterError({
		kind: response.ok ? "api_failure" : "http_status",
		message: `FxTwitter request failed with status ${String(status)}: ${message}`,
		status: response.status,
	});
}

function toFxTwitterError(cause: unknown) {
	if (cause instanceof FxTwitterError) return cause;
	if (cause instanceof DOMException && cause.name === "AbortError") {
		return new FxTwitterError({
			kind: "timeout",
			message: "FxTwitter request timed out",
			cause,
		});
	}
	return new FxTwitterError({
		kind: "network",
		message:
			cause instanceof Error ? cause.message : "FxTwitter request failed",
		cause,
	});
}

function shouldRetry(error: FxTwitterError) {
	return (
		error.kind === "rate_limited" ||
		error.kind === "network" ||
		error.kind === "timeout" ||
		(error.kind === "http_status" && (error.status ?? 0) >= 500)
	);
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function requestFxTwitterJson(
	url: URL,
	runtime: RuntimeServices,
): Promise<JsonRecord> {
	if (url.origin !== FXTWITTER_ORIGIN || url.username || url.password) {
		throw new FxTwitterError({
			kind: "origin_policy",
			message: "FxTwitter requests must use the fixed public origin",
		});
	}
	const deadline = runtime.now().getTime() + FXTWITTER_TOTAL_DEADLINE_MS;
	let lastError: FxTwitterError | undefined;
	for (let attempt = 1; attempt <= FXTWITTER_MAX_ATTEMPTS; attempt += 1) {
		const remaining = deadline - runtime.now().getTime();
		if (remaining <= 0) {
			throw new FxTwitterError({
				kind: "timeout",
				message: "FxTwitter request exceeded its total deadline",
			});
		}
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			Math.min(FXTWITTER_TIMEOUT_MS, remaining),
		);
		try {
			const response = await runtime.fetch(url, {
				method: "GET",
				headers: {
					Accept: "application/json",
					"User-Agent": FXTWITTER_USER_AGENT,
				},
				redirect: "manual",
				signal: controller.signal,
			});
			if (response.status >= 300 && response.status < 400) {
				throw new FxTwitterError({
					kind: "origin_policy",
					message:
						"FxTwitter redirects are rejected by the fixed-origin policy",
					status: response.status,
				});
			}
			const body = await readBoundedJson(response);
			const root = asRecord(body);
			const providerCode = asNumber(root?.code);
			if (!root)
				throw decodeError("FxTwitter returned an invalid response object");
			if (!response.ok || providerCode !== 200) {
				throw statusError(response, root, runtime.now());
			}
			return root;
		} catch (cause) {
			lastError = toFxTwitterError(cause);
			if (attempt >= FXTWITTER_MAX_ATTEMPTS || !shouldRetry(lastError)) {
				throw lastError;
			}
			const base =
				lastError.retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1), 1_000);
			const jittered = Math.ceil(base + base * 0.25 * runtime.random());
			const delay = Math.min(FXTWITTER_MAX_BACKOFF_MS, jittered);
			if (runtime.now().getTime() + delay >= deadline) throw lastError;
			await sleep(delay);
		} finally {
			clearTimeout(timeout);
		}
	}
	throw (
		lastError ??
		new FxTwitterError({ kind: "network", message: "FxTwitter request failed" })
	);
}

function failureSummary(error: FxTwitterError): FxTwitterFailureSummary {
	return {
		kind: error.kind,
		message: error.message,
		status: error.status,
		retryAfterMs: error.retryAfterMs,
	};
}

function partialReasonForError(error: FxTwitterError): FxTwitterPartialReason {
	if (error.kind === "timeout") return "timeout";
	if (error.kind === "rate_limited") return "rate_limited";
	if (error.kind === "decode_error" || error.kind === "response_too_large") {
		return "decode_error";
	}
	if (error.kind === "cursor_missing_or_malformed") {
		return "cursor_missing_or_malformed";
	}
	if (error.kind === "cursor_repeated") return "cursor_repeated";
	if (error.kind === "cursor_cycle") return "cursor_cycle";
	return "upstream_error";
}

function cursorFromRoot(root: JsonRecord) {
	const cursor = asRecord(root.cursor);
	if (!cursor || !Object.hasOwn(cursor, "bottom")) {
		throw new FxTwitterError({
			kind: "cursor_missing_or_malformed",
			message: "FxTwitter search response is missing cursor.bottom",
		});
	}
	if (cursor.bottom === null) return null;
	const bottom = asString(cursor.bottom);
	if (!bottom) {
		throw new FxTwitterError({
			kind: "cursor_missing_or_malformed",
			message: "FxTwitter search response has an invalid cursor.bottom",
		});
	}
	return bottom;
}

function normalizeCollectionValues(values: readonly unknown[]) {
	const trees: NormalizedStatusTree[] = [];
	const ids = new Set<string>();
	let decodeFailure: FxTwitterError | undefined;
	for (const value of values) {
		try {
			const tree = normalizeStatusTree(value);
			if (ids.has(tree.primary.id)) continue;
			ids.add(tree.primary.id);
			trees.push(tree);
		} catch (cause) {
			decodeFailure ??= toFxTwitterError(cause);
		}
	}
	return { trees, decodeFailure };
}

function persistTweetCollection(options: {
	endpointFamily: "thread" | "conversation" | "search";
	requestKey: string;
	sourceUrl: string;
	trees: readonly NormalizedStatusTree[];
	collection: FxTwitterCollectionMetadata;
}) {
	const { payload, allTweetIds } = mergeStatusTrees(options.trees);
	const provenance = new Map(
		allTweetIds.map((tweetId) => [tweetId, sourceUrlForTweet(tweetId)]),
	);
	const db = getNativeDb({ seedDemoData: false });
	let importedIds: string[] = [];
	db.transaction(() => {
		importedIds = ingestTweetPayload(db, {
			accountId: "public",
			payload,
			source: "fxtwitter",
			provenance: { sourceUrlByTweetId: provenance },
		});
		recordFxTwitterFetch(db, {
			endpointFamily: options.endpointFamily,
			requestKey: options.requestKey,
			sourceUrl: options.sourceUrl,
			retrievedAt: options.collection.retrievedAt,
			pagesFetched: options.collection.pagesFetched,
			itemsObserved: options.collection.itemsObserved,
			collection: options.collection,
			items: allTweetIds.map((id) => ({ kind: "tweet", id })),
		});
	})();
	return importedIds;
}

export function getTweetByIdViaFxTwitterEffect(
	input: string,
	runtime: RuntimeServices = defaultRuntimeServices,
): Effect.Effect<FxTwitterTweet, FxTwitterError> {
	return Effect.tryPromise({
		try: async () => {
			assertFxTwitterCapability("tweet");
			const tweetId = parseFxTwitterTweetId(input);
			const url = endpointUrl(`/2/status/${tweetId}`);
			const root = await requestFxTwitterJson(url, runtime);
			const tree = normalizeStatusTree(root.status);
			if (tree.primary.id !== tweetId) {
				throw decodeError(
					`FxTwitter returned tweet ${tree.primary.id} for requested tweet ${tweetId}`,
				);
			}
			const merged = mergeStatusTrees([tree]);
			return {
				payload: merged.payload,
				provenance: new Map(
					merged.allTweetIds.map((id) => [id, sourceUrlForTweet(tweetId)]),
				),
			};
		},
		catch: toFxTwitterError,
	});
}

export function importTweetsViaFxTwitterEffect(
	inputs: readonly string[],
	runtime: RuntimeServices = defaultRuntimeServices,
): Effect.Effect<FxTwitterImportResult, FxTwitterError> {
	return Effect.gen(function* () {
		const tweetIds = yield* Effect.try({
			try: () => [...new Set(inputs.map(parseFxTwitterTweetId))],
			catch: toFxTwitterError,
		});
		if (tweetIds.length === 0) {
			return yield* Effect.fail(
				inputError("Pass at least one public tweet ID"),
			);
		}
		if (tweetIds.length > FXTWITTER_MAX_TWEETS_PER_IMPORT) {
			return yield* Effect.fail(
				inputError(
					`FxTwitter import accepts at most ${String(FXTWITTER_MAX_TWEETS_PER_IMPORT)} tweets per invocation`,
				),
			);
		}
		const fetched = yield* Effect.forEach(
			tweetIds,
			(tweetId) => getTweetByIdViaFxTwitterEffect(tweetId, runtime),
			{ concurrency: 1 },
		);
		return yield* Effect.try({
			try: () => {
				const db = getNativeDb({ seedDemoData: false });
				const importedIds = new Set<string>();
				for (const result of fetched) {
					for (const tweetId of ingestTweetPayload(db, {
						accountId: "public",
						payload: result.payload,
						source: "fxtwitter",
						provenance: { sourceUrlByTweetId: result.provenance },
					})) {
						importedIds.add(tweetId);
					}
				}
				return {
					ok: true,
					readOnlyTransport: true,
					source: "fxtwitter",
					endpoint: FXTWITTER_ORIGIN,
					requestedCount: tweetIds.length,
					importedCount: importedIds.size,
					items: tweetIds.map((tweetId) => ({
						tweetId,
						source: "fxtwitter" as const,
						sourceUrl: sourceUrlForTweet(tweetId),
					})),
				} satisfies FxTwitterImportResult;
			},
			catch: toFxTwitterError,
		});
	});
}

async function importThreadCollection(
	input: string,
	endpointFamily: "thread" | "conversation",
	options: FxTwitterCollectionOptions,
	runtime: RuntimeServices,
): Promise<FxTwitterCollectionImportResult> {
	assertFxTwitterCapability(endpointFamily);
	const tweetId = parseFxTwitterTweetId(input);
	const limit = validateLimit(options.limit, 500);
	const url = endpointUrl(`/2/${endpointFamily}/${tweetId}`);
	const retrievedAt = runtime.now().toISOString();
	const root = await requestFxTwitterJson(url, runtime);
	const values = [
		root.status,
		...asArray(root.thread),
		...(endpointFamily === "conversation" ? asArray(root.replies) : []),
	];
	const normalized = normalizeCollectionValues(values);
	if (normalized.trees.length === 0) {
		throw (
			normalized.decodeFailure ??
			decodeError("FxTwitter returned no usable public tweets")
		);
	}
	const selected = normalized.trees.slice(0, limit);
	const partialReasons: FxTwitterPartialReason[] = [
		"endpoint_has_no_exhaustion_proof",
	];
	if (normalized.trees.length > limit) partialReasons.push("caller_limit");
	if (normalized.decodeFailure) partialReasons.push("decode_error");
	const cursor = asRecord(root.cursor);
	const nextCursor = asString(cursor?.bottom);
	const focal = asRecord(root.status);
	const collection: FxTwitterCollectionMetadata = {
		state: "partial",
		partialReasons: unique(partialReasons),
		pagesFetched: 1,
		itemsObserved: selected.length,
		retrievedAt,
		terminalCursor: null,
		nextCursor,
		upstreamCount: asNumber(focal?.replies),
		interruption: normalized.decodeFailure
			? failureSummary(normalized.decodeFailure)
			: undefined,
	};
	const importedIds = persistTweetCollection({
		endpointFamily,
		requestKey: tweetId,
		sourceUrl: url.toString(),
		trees: selected,
		collection,
	});
	return {
		ok: true,
		readOnlyTransport: true,
		source: "fxtwitter",
		endpoint: FXTWITTER_ORIGIN,
		endpointFamily,
		request: tweetId,
		importedCount: importedIds.length,
		tweetIds: importedIds,
		collection,
	};
}

export function importThreadViaFxTwitterEffect(
	input: string,
	options: FxTwitterCollectionOptions = {},
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return Effect.tryPromise({
		try: () => importThreadCollection(input, "thread", options, runtime),
		catch: toFxTwitterError,
	});
}

export function importConversationViaFxTwitterEffect(
	input: string,
	options: FxTwitterCollectionOptions = {},
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return Effect.tryPromise({
		try: () => importThreadCollection(input, "conversation", options, runtime),
		catch: toFxTwitterError,
	});
}

export function importProfileViaFxTwitterEffect(
	input: string,
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return Effect.tryPromise({
		try: async (): Promise<FxTwitterProfileImportResult> => {
			assertFxTwitterCapability("profile");
			const handle = parseFxTwitterHandle(input);
			const url = endpointUrl(`/2/profile/${encodeURIComponent(handle)}`);
			const retrievedAt = runtime.now().toISOString();
			const root = await requestFxTwitterJson(url, runtime);
			const user = normalizeAuthor(root.user);
			if (user.username.toLowerCase() !== handle.toLowerCase()) {
				throw decodeError(
					`FxTwitter returned @${user.username} for requested @${handle}`,
				);
			}
			const db = getNativeDb({ seedDemoData: false });
			let profile: ProfileRecord | undefined;
			db.transaction(() => {
				profile = upsertProfileFromXUser(db, user).profile;
				recordFxTwitterFetch(db, {
					endpointFamily: "profile",
					requestKey: handle.toLowerCase(),
					sourceUrl: url.toString(),
					retrievedAt,
					pagesFetched: 1,
					itemsObserved: 1,
					items: [{ kind: "profile", id: profile.id }],
				});
			})();
			if (!profile) throw decodeError("FxTwitter profile persistence failed");
			return {
				ok: true,
				readOnlyTransport: true,
				source: "fxtwitter",
				endpoint: FXTWITTER_ORIGIN,
				endpointFamily: "profile",
				request: handle,
				retrievedAt,
				pagesFetched: 1,
				itemsObserved: 1,
				profile,
			};
		},
		catch: toFxTwitterError,
	});
}

async function importSearchCollection(
	input: string,
	options: FxTwitterCollectionOptions,
	runtime: RuntimeServices,
): Promise<FxTwitterCollectionImportResult> {
	assertFxTwitterCapability("search");
	const query = parseFxTwitterSearchQuery(input);
	const limit = validateLimit(options.limit, 20);
	const maxPages = validateMaxPages(options.maxPages);
	const feed = options.feed ?? "latest";
	if (feed !== "latest" && feed !== "top" && feed !== "media") {
		throw inputError("FxTwitter search feed must be latest, top, or media");
	}
	const retrievedAt = runtime.now().toISOString();
	const pageSize = Math.min(100, limit);
	const sourceUrl = endpointUrl("/2/search", {
		q: query,
		feed,
		count: pageSize,
	}).toString();
	const trees: NormalizedStatusTree[] = [];
	const itemIds = new Set<string>();
	const partialReasons: FxTwitterPartialReason[] = [];
	const seenCursors = new Set<string>();
	let pagesFetched = 0;
	let currentCursor: string | undefined;
	let nextCursor: string | undefined;
	let terminalCursor: string | null = null;
	let interruption: FxTwitterFailureSummary | undefined;
	let terminalObserved = false;

	for (;;) {
		const url = endpointUrl("/2/search", {
			q: query,
			feed,
			count: pageSize,
			cursor: currentCursor,
		});
		let root: JsonRecord;
		try {
			root = await requestFxTwitterJson(url, runtime);
		} catch (cause) {
			const error = toFxTwitterError(cause);
			if (trees.length === 0) throw error;
			partialReasons.push(partialReasonForError(error));
			interruption = failureSummary(error);
			nextCursor = currentCursor;
			break;
		}
		pagesFetched += 1;
		if (!Array.isArray(root.results)) {
			const error = decodeError("FxTwitter search response is missing results");
			if (trees.length === 0) throw error;
			partialReasons.push("decode_error");
			interruption = failureSummary(error);
			break;
		}
		const normalized = normalizeCollectionValues(root.results);
		for (const tree of normalized.trees) {
			if (itemIds.has(tree.primary.id)) continue;
			if (trees.length >= limit) {
				partialReasons.push("caller_limit");
				break;
			}
			itemIds.add(tree.primary.id);
			trees.push(tree);
		}
		if (normalized.decodeFailure) {
			if (trees.length === 0) throw normalized.decodeFailure;
			partialReasons.push("decode_error");
			interruption = failureSummary(normalized.decodeFailure);
			break;
		}

		let bottom: string | null;
		try {
			bottom = cursorFromRoot(root);
		} catch (cause) {
			const error = toFxTwitterError(cause);
			if (trees.length === 0 && root.results.length > 0) throw error;
			partialReasons.push("cursor_missing_or_malformed");
			interruption = failureSummary(error);
			break;
		}
		if (bottom === null) {
			terminalObserved = true;
			terminalCursor = currentCursor ?? null;
			break;
		}
		nextCursor = bottom;
		if (trees.length >= limit) {
			partialReasons.push("caller_limit");
			break;
		}
		if (pagesFetched >= maxPages) {
			partialReasons.push("max_pages");
			break;
		}
		if (bottom === currentCursor) {
			const error = new FxTwitterError({
				kind: "cursor_repeated",
				message: "FxTwitter search repeated the current cursor",
			});
			partialReasons.push("cursor_repeated");
			interruption = failureSummary(error);
			break;
		}
		if (seenCursors.has(bottom)) {
			const error = new FxTwitterError({
				kind: "cursor_cycle",
				message: "FxTwitter search cursor chain formed a cycle",
			});
			partialReasons.push("cursor_cycle");
			interruption = failureSummary(error);
			break;
		}
		seenCursors.add(bottom);
		currentCursor = bottom;
		nextCursor = undefined;
	}

	const reasons = unique(partialReasons);
	const collection: FxTwitterCollectionMetadata = {
		state: terminalObserved && reasons.length === 0 ? "complete" : "partial",
		partialReasons: reasons,
		pagesFetched,
		itemsObserved: trees.length,
		retrievedAt,
		terminalCursor,
		nextCursor,
		interruption,
	};
	const importedIds = persistTweetCollection({
		endpointFamily: "search",
		requestKey: JSON.stringify({ query, feed }),
		sourceUrl,
		trees,
		collection,
	});
	return {
		ok: true,
		readOnlyTransport: true,
		source: "fxtwitter",
		endpoint: FXTWITTER_ORIGIN,
		endpointFamily: "search",
		request: query,
		importedCount: importedIds.length,
		tweetIds: importedIds,
		collection,
	};
}

export function importSearchViaFxTwitterEffect(
	input: string,
	options: FxTwitterCollectionOptions = {},
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return Effect.tryPromise({
		try: () => importSearchCollection(input, options, runtime),
		catch: toFxTwitterError,
	});
}

export function importTweetsViaFxTwitter(
	inputs: readonly string[],
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return runEffectPromise(importTweetsViaFxTwitterEffect(inputs, runtime));
}

export function importThreadViaFxTwitter(
	input: string,
	options: FxTwitterCollectionOptions = {},
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return runEffectPromise(
		importThreadViaFxTwitterEffect(input, options, runtime),
	);
}

export function importConversationViaFxTwitter(
	input: string,
	options: FxTwitterCollectionOptions = {},
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return runEffectPromise(
		importConversationViaFxTwitterEffect(input, options, runtime),
	);
}

export function importProfileViaFxTwitter(
	input: string,
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return runEffectPromise(importProfileViaFxTwitterEffect(input, runtime));
}

export function importSearchViaFxTwitter(
	input: string,
	options: FxTwitterCollectionOptions = {},
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return runEffectPromise(
		importSearchViaFxTwitterEffect(input, options, runtime),
	);
}

export type { FxTwitterCollectionMetadata, FxTwitterPartialReason };
