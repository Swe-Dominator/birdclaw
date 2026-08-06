import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { inboxResponseSchema } from "#/lib/api-contracts";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { listInboxItems } from "#/lib/inbox";
import type { InboxKind } from "#/lib/types";

function parseNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const Route = createFileRoute("/api/inbox")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						requestBackupAutoUpdate();
						const url = new URL(request.url);
						const kind = (url.searchParams.get("kind") ?? "mixed") as InboxKind;
						return jsonResponse(
							inboxResponseSchema.parse(
								listInboxItems({
									kind: kind === "mentions" || kind === "dms" ? kind : "mixed",
									account: url.searchParams.get("account") ?? undefined,
									minScore: parseNumber(url.searchParams.get("minScore")),
									hideLowSignal: url.searchParams.get("hideLowSignal") === "1",
									limit: parseNumber(url.searchParams.get("limit")) ?? 20,
								}),
							),
						);
					}),
				),
		},
	},
});
