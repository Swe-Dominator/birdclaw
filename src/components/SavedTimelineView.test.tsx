import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { SavedTimelineView } from "./SavedTimelineView";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({
		item,
		onReply,
	}: {
		item: { id: string; text: string };
		onReply?: (tweetId: string) => void;
	}) => (
		<article>
			<span>{item.text}</span>
			{onReply ? (
				<button onClick={() => onReply(item.id)} type="button">
					reply {item.id}
				</button>
			) : null}
		</article>
	),
}));

describe("SavedTimelineView", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		window.localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads liked posts through the query API", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "liked_1", text: "good thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("good thing")).toBeInTheDocument();
		const queryUrl = queryUrls[0];
		expect(queryUrl?.searchParams.get("liked")).toBe("true");
		expect(queryUrl?.searchParams.get("bookmarked")).toBeNull();
	});

	it("loads bookmarks through the query API", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "bookmark_1", text: "saved thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("saved thing")).toBeInTheDocument();
		});
		const queryUrl = queryUrls[0];
		expect(queryUrl?.searchParams.get("bookmarked")).toBe("true");
		expect(queryUrl?.searchParams.get("liked")).toBeNull();
	});

	it("waits for the default account before querying and trims search params", async () => {
		const queryUrls: URL[] = [];
		let resolveStatus!: (response: Response) => void;
		const statusResponse = new Promise<Response>((resolve) => {
			resolveStatus = resolve;
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return statusResponse;
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return Response.json({
					resource: "home",
					items: [{ id: "liked_2", text: "searchable thing" }],
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(queryUrls).toHaveLength(0);
		resolveStatus(
			Response.json({
				stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
				transport: { statusText: "local" },
				accounts: [
					{
						id: "acct_primary",
						name: "Primary",
						handle: "steipete",
						transport: "archive",
						isDefault: 1,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				archives: [],
			}),
		);

		expect(await screen.findByText("searchable thing")).toBeInTheDocument();
		expect(queryUrls).toHaveLength(1);
		expect(queryUrls[0]?.searchParams.get("account")).toBe("acct_primary");
		fireEvent.change(screen.getByPlaceholderText("Search likes"), {
			target: { value: "  launch  " },
		});

		await waitFor(() => {
			expect(queryUrls.at(-1)?.searchParams.get("search")).toBe("launch");
		});
	});

	it("uses a stored account immediately while status is pending", async () => {
		window.localStorage.setItem("birdclaw:selected-account-id", "acct_primary");
		const queryUrls: URL[] = [];
		let resolveStatus!: (response: Response) => void;
		const statusResponse = new Promise<Response>((resolve) => {
			resolveStatus = resolve;
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return statusResponse;
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return Response.json({
					resource: "home",
					items: [{ id: "liked_stored", text: "stored account item" }],
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("stored account item")).toBeInTheDocument();
		expect(queryUrls).toHaveLength(1);
		expect(queryUrls[0]?.searchParams.get("account")).toBe("acct_primary");
		resolveStatus(
			Response.json({
				stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
				transport: { statusText: "local" },
				accounts: [
					{
						id: "acct_primary",
						name: "Primary",
						handle: "steipete",
						transport: "archive",
						isDefault: 1,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				archives: [],
			}),
		);
		await waitFor(() => expect(queryUrls).toHaveLength(1));
	});

	it("falls back to one unscoped query when status fails", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) throw new Error("status unavailable");
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return Response.json({
					resource: "home",
					items: [{ id: "liked_fallback", text: "fallback item" }],
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("fallback item")).toBeInTheDocument();
		expect(queryUrls).toHaveLength(1);
		expect(queryUrls[0]?.searchParams.has("account")).toBe(false);
	});

	it("syncs the matching saved collection and reloads local data", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "liked_sync", text: "fresh liked thing" }],
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_likes_1",
							kind: "likes",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 4 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "likes",
								summary: "Synced 4 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("fresh liked thing")).toBeInTheDocument();
		const initialQueryCount = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "Sync likes" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "likes" }]);
			expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
		});
	});

	it("ignores empty replies and refreshes after sending a reply", async () => {
		const actionBodies: unknown[] = [];
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "bookmark_2", text: "reply target" }],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.body) {
					actionBodies.push(JSON.parse(String(init.body)));
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const promptSpy = vi
			.spyOn(window, "prompt")
			.mockReturnValueOnce("  ")
			.mockReturnValueOnce("Thanks");

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		expect(await screen.findByText("reply target")).toBeInTheDocument();
		const initialQueryCount = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "reply bookmark_2" }));
		expect(actionBodies).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "reply bookmark_2" }));

		await waitFor(() => {
			expect(actionBodies).toEqual([
				expect.objectContaining({ tweetId: "bookmark_2", text: "Thanks" }),
			]);
			expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
		});
		expect(promptSpy).toHaveBeenCalledTimes(2);
	});

	it("shows a retryable error when saved posts fail to load", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				throw new Error("Saved store unavailable");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		expect(
			await screen.findByText("Could not load bookmarks"),
		).toBeInTheDocument();
		expect(screen.getByText("Saved store unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});
});
