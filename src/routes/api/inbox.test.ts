// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const listInboxItemsMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/inbox", () => ({
	listInboxItems: (...args: unknown[]) => listInboxItemsMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	requestBackupAutoUpdate: () => maybeAutoUpdateBackupMock(),
}));

import { Route } from "./inbox";

const GET = getRouteHandler(Route, "GET");

describe("api inbox route", () => {
	beforeEach(() => {
		listInboxItemsMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
	});

	it("parses inbox filters", async () => {
		listInboxItemsMock.mockReturnValue({
			items: [],
			stats: { total: 0, openai: 0, heuristic: 0 },
		});
		const response = await GET({
			request: new Request(
				"http://localhost/api/inbox?kind=dms&minScore=55&hideLowSignal=1&limit=5",
			),
		});

		expect(listInboxItemsMock).toHaveBeenCalledWith({
			kind: "dms",
			account: undefined,
			minScore: 55,
			hideLowSignal: true,
			limit: 5,
		});
		expect(response.status).toBe(200);
	});

	it("falls back to mixed kind and default limit for invalid params", async () => {
		listInboxItemsMock.mockReturnValue({
			items: [],
			stats: { total: 0, openai: 0, heuristic: 0 },
		});

		await GET({
			request: new Request(
				"http://localhost/api/inbox?kind=nope&minScore=bad&limit=nan",
			),
		});

		expect(listInboxItemsMock).toHaveBeenCalledWith({
			kind: "mixed",
			account: undefined,
			minScore: undefined,
			hideLowSignal: false,
			limit: 20,
		});
	});

	it("uses defaults when optional params are omitted", async () => {
		listInboxItemsMock.mockReturnValue({
			items: [],
			stats: { total: 0, openai: 0, heuristic: 0 },
		});

		await GET({
			request: new Request("http://localhost/api/inbox"),
		});

		expect(listInboxItemsMock).toHaveBeenCalledWith({
			kind: "mixed",
			account: undefined,
			minScore: undefined,
			hideLowSignal: false,
			limit: 20,
		});
	});

	it("passes selected accounts through to inbox queries", async () => {
		listInboxItemsMock.mockReturnValue({
			items: [],
			stats: { total: 0, openai: 0, heuristic: 0 },
		});

		await GET({
			request: new Request("http://localhost/api/inbox?account=acct_alt"),
		});

		expect(listInboxItemsMock).toHaveBeenCalledWith(
			expect.objectContaining({ account: "acct_alt" }),
		);
	});
});
