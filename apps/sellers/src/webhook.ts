import type { IncomingHttpHeaders } from "node:http";
import { verifyWebhook } from "@inkbox/sdk";

/**
 * Inkbox signature check that never throws: the SDK's timingSafeEqual throws on a signature of the
 * wrong length, which inside the async request handler would be an unhandled rejection and stop
 * the whole seller server.
 */
export function isSignedWebhook(payload: Buffer, headers: IncomingHttpHeaders | Record<string, string>, secret: string): boolean {
  try {
    return verifyWebhook({ payload, headers, secret });
  } catch {
    return false;
  }
}
