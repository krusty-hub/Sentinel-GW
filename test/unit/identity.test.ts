import { describe, it, expect } from 'vitest';
import {
  isIpInCidr,
  extractClientIp,
  extractJwtSub,
  extractIdentityAndPolicy,
} from '../../src/middleware/identity.js';
import { GatewayConfig, RouteConfig } from '../../src/config/index.js';
import { FastifyRequest } from 'fastify';

describe('Identity Extraction & Priority Hierarchy Tests', () => {
  describe('CIDR Subnet Matching', () => {
    it('correctly matches IPv4 addresses against subnets', () => {
      expect(isIpInCidr('10.0.5.21', '10.0.0.0/8')).toBe(true);
      expect(isIpInCidr('172.16.4.1', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
      expect(isIpInCidr('192.168.1.100', '192.168.0.0/16')).toBe(true);
      expect(isIpInCidr('127.0.0.1', '127.0.0.1/32')).toBe(true);
      expect(isIpInCidr('8.8.8.8', '10.0.0.0/8')).toBe(false);
    });
  });

  describe('Client IP Extraction (Rightmost Untrusted IP)', () => {
    const trustedProxies = ['10.0.0.0/8', '172.16.0.0/12'];

    it('finds the rightmost untrusted IP in X-Forwarded-For chain', () => {
      // Client (203.0.113.195) -> Proxy1 (198.51.100.1) -> TrustedProxy2 (172.16.0.2) -> TrustedProxy3 (10.0.0.1)
      const mockReq = {
        headers: {
          'x-forwarded-for': '203.0.113.195, 198.51.100.1, 172.16.0.2, 10.0.0.1',
        },
        socket: { remoteAddress: '10.0.0.1' },
      } as unknown as FastifyRequest;

      const ip = extractClientIp(mockReq, trustedProxies);
      expect(ip).toBe('198.51.100.1');
    });

    it('falls back to leftmost IP if all in XFF are trusted', () => {
      const mockReq = {
        headers: {
          'x-forwarded-for': '10.0.0.2, 10.0.0.1',
        },
        socket: { remoteAddress: '10.0.0.1' },
      } as unknown as FastifyRequest;

      const ip = extractClientIp(mockReq, trustedProxies);
      expect(ip).toBe('10.0.0.2');
    });

    it('falls back to socket remoteAddress if no XFF header is present', () => {
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '198.51.100.42' },
      } as unknown as FastifyRequest;

      const ip = extractClientIp(mockReq, trustedProxies);
      expect(ip).toBe('198.51.100.42');
    });
  });

  describe('JWT sub claim extraction', () => {
    it('decodes sub claim from unpadded base64url JWT payload', () => {
      // Payload: {"sub": "user_42", "iat": 1516239022}
      const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const payload = Buffer.from(JSON.stringify({ sub: 'user_42', iat: 1516239022 })).toString('base64url');
      const token = `${header}.${payload}.signature`;

      const sub = extractJwtSub(`Bearer ${token}`);
      expect(sub).toBe('user_42');
    });

    it('returns null for malformed or missing Authorization header', () => {
      expect(extractJwtSub(undefined)).toBeNull();
      expect(extractJwtSub('Basic abc')).toBeNull();
      expect(extractJwtSub('Bearer invalid-token')).toBeNull();
    });
  });

  describe('Priority Hierarchy Resolution', () => {
    const config: GatewayConfig = {
      server: {
        port: 8080,
        node_id: 'test-node',
        total_nodes: 1,
        trusted_proxies: ['10.0.0.0/8'],
        upstream_timeout_ms: 5000,
      },
      redis: {
        address: 'localhost:6379',
        pool_size: 10,
        command_timeout_ms: 15,
        circuit_breaker: { failure_threshold: 5, recovery_window_ms: 10000 },
      },
      tiers: {
        free: { algorithm: 'token_bucket', capacity: 20, refill_rate_per_sec: 1.0 },
        pro: { algorithm: 'token_bucket', capacity: 500, refill_rate_per_sec: 50.0 },
      },
      api_keys: {
        key_valid_pro: { tier: 'pro' },
      },
      routes: [],
    };

    const route: RouteConfig = {
      id: 'payments_api',
      path_prefix: '/api/v1/payments',
      methods: ['POST', 'GET'],
      upstream_url: 'http://upstream:4000',
      identity_source: 'api_key',
      tier_based: true,
    };

    it('prioritizes X-API-Key over JWT and IP', () => {
      const mockReq = {
        headers: {
          'x-api-key': 'key_valid_pro',
          authorization: 'Bearer valid.jwt.token',
          'x-forwarded-for': '198.51.100.99',
        },
      } as unknown as FastifyRequest;

      const identity = extractIdentityAndPolicy(mockReq, route, config);
      expect(identity.source).toBe('api_key');
      expect(identity.clientId).toBe('key_key_valid_pro');
      expect(identity.tier).toBe('pro');
      expect(identity.policy.capacity).toBe(500);
    });
  });
});
