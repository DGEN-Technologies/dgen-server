import type { FastifyRequest } from "fastify";

/**
 * Whether to trust Cloudflare headers for IP resolution.
 * Only enable if server is actually behind Cloudflare.
 *
 * Set TRUST_CLOUDFLARE=true in production if behind Cloudflare.
 * If false/unset, cf-connecting-ip header will be ignored to prevent spoofing.
 */
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === "true";

if (TRUST_CLOUDFLARE) {
	console.log("[IP] Trusting Cloudflare cf-connecting-ip header");
}

/**
 * Get the client IP address from a request.
 *
 * Uses cf-connecting-ip header only if TRUST_CLOUDFLARE=true.
 * Otherwise falls back to req.ip (which respects Fastify's trustProxy setting).
 *
 * This prevents rate limit bypass via header spoofing on non-Cloudflare deployments.
 */
export function getClientIp(req: FastifyRequest): string | null {
	if (TRUST_CLOUDFLARE) {
		const cfIp = req.headers["cf-connecting-ip"];
		if (typeof cfIp === "string" && cfIp) {
			return cfIp;
		}
	}

	return req.ip || null;
}

/**
 * Get client IP from headers object (for use outside request context).
 * Less preferred - use getClientIp(req) when possible.
 */
export function getClientIpFromHeaders(
	headers: Record<string, string | string[] | undefined>,
	fallback: string | null = null,
): string | null {
	if (TRUST_CLOUDFLARE) {
		const cfIp = headers["cf-connecting-ip"];
		if (typeof cfIp === "string" && cfIp) {
			return cfIp;
		}
	}

	return fallback;
}
