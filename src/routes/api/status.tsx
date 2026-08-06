import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { queryEnvelopeSchema } from "#/lib/api-contracts";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getQueryEnvelopeEffect } from "#/lib/query-status";

export const Route = createFileRoute("/api/status")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						requestBackupAutoUpdate();
						const envelope = yield* getQueryEnvelopeEffect({
							includeArchives: false,
						});
						return jsonResponse(queryEnvelopeSchema.parse(envelope));
					}),
				),
		},
	},
});
