import { FastifyRequest } from 'fastify';
import { RouteConfig, GatewayConfig } from '../config/index.js';
import { RateLimitPolicy } from '../limiter/types.js';
export interface ExtractedIdentity {
    clientId: string;
    tier?: string;
    policy: RateLimitPolicy;
    source: 'api_key' | 'jwt' | 'ip';
}
/**
 * Checks if an IPv4 address is within a CIDR subnet.
 */
export declare function isIpInCidr(ip: string, cidr: string): boolean;
/**
 * Parses client IP from X-Forwarded-For by finding the rightmost untrusted IP.
 */
export declare function extractClientIp(req: FastifyRequest, trustedProxies: string[]): string;
/**
 * Extracts sub claim from Bearer JWT without external library.
 */
export declare function extractJwtSub(authHeader?: string): string | null;
/**
 * Extracts identity and resolves applicable policy based on route config & priority hierarchy.
 */
export declare function extractIdentityAndPolicy(req: FastifyRequest, route: RouteConfig, config: GatewayConfig): ExtractedIdentity;
