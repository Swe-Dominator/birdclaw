import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { networkMapResponseSchema } from "#/lib/api-contracts";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getNetworkMap, type NetworkMapKind } from "#/lib/network-map";

function parseType(value: string | null): NetworkMapKind {
	if (
		value === "followers" ||
		value === "following" ||
		value === "mutual" ||
		value === "all"
	) {
		return value;
	}
	return "all";
}

export const Route = createFileRoute("/api/network-map")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						requestBackupAutoUpdate();
						const url = new URL(request.url);
						const response = yield* Effect.promise(() =>
							getNetworkMap({
								account: url.searchParams.get("account") ?? undefined,
								type: parseType(url.searchParams.get("type")),
								limit: parseBoundedInteger(url.searchParams.get("limit"), {
									max: 50_000,
								}),
								geocodeLimit: parseBoundedInteger(
									url.searchParams.get("geocodeLimit"),
									{ max: 500, min: 0 },
								),
								refresh: url.searchParams.get("refresh") === "true",
								signal: request.signal,
							}),
						);
						return jsonResponse(networkMapResponseSchema.parse(response));
					}),
				),
		},
	},
});
