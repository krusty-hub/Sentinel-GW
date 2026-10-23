/**
 * Checks if an IPv4 address is within a CIDR subnet.
 */
export function isIpInCidr(ip, cidr) {
    // Normalize IPv6 mapped IPv4 like ::ffff:127.0.0.1
    const cleanIp = ip.replace(/^::ffff:/, '');
    if (!cidr.includes('/')) {
        return cleanIp === cidr;
    }
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits) || bits < 0 || bits > 32)
        return false;
    const ipNum = ipv4ToNumber(cleanIp);
    const rangeNum = ipv4ToNumber(range);
    if (ipNum === null || rangeNum === null)
        return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
}
function ipv4ToNumber(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4)
        return null;
    let num = 0;
    for (const part of parts) {
        const n = parseInt(part, 10);
        if (isNaN(n) || n < 0 || n > 255)
            return null;
        num = (num << 8) + n;
    }
    return num >>> 0;
}
/**
 * Parses client IP from X-Forwarded-For by finding the rightmost untrusted IP.
 */
export function extractClientIp(req, trustedProxies) {
    const xff = req.headers['x-forwarded-for'];
    const socketIp = req.socket?.remoteAddress || req.ip || '127.0.0.1';
    if (!xff) {
        return socketIp.replace(/^::ffff:/, '');
    }
    const rawHeader = Array.isArray(xff) ? xff.join(',') : xff;
    const ips = rawHeader
        .split(',')
        .map((s) => s.trim().replace(/^::ffff:/, ''))
        .filter(Boolean);
    if (ips.length === 0) {
        return socketIp.replace(/^::ffff:/, '');
    }
    // Walk from right to left: find first untrusted IP
    for (let i = ips.length - 1; i >= 0; i--) {
        const currentIp = ips[i];
        const isTrusted = trustedProxies.some((cidr) => isIpInCidr(currentIp, cidr));
        if (!isTrusted) {
            return currentIp;
        }
    }
    // If all IPs in XFF are trusted proxies, the client is the leftmost IP
    return ips[0];
}
/**
 * Extracts sub claim from Bearer JWT without external library.
 */
export function extractJwtSub(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.slice(7).trim();
    const parts = token.split('.');
    if (parts.length < 2) {
        return null;
    }
    try {
        const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payloadBase64.padEnd(payloadBase64.length + ((4 - (payloadBase64.length % 4)) % 4), '=');
        const jsonStr = Buffer.from(padded, 'base64').toString('utf-8');
        const parsed = JSON.parse(jsonStr);
        return typeof parsed.sub === 'string' ? parsed.sub : null;
    }
    catch {
        return null;
    }
}
/**
 * Extracts identity and resolves applicable policy based on route config & priority hierarchy.
 */
export function extractIdentityAndPolicy(req, route, config) {
    const apiKeyHeader = req.headers['x-api-key'];
    const apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : undefined;
    const authHeader = req.headers['authorization'];
    // Priority 1: X-API-Key
    if (apiKey && (route.identity_source === 'api_key' || !route.identity_source)) {
        let tierName = 'free';
        if (config.api_keys && config.api_keys[apiKey]) {
            tierName = config.api_keys[apiKey].tier;
        }
        else if (apiKey.includes('pro')) {
            tierName = 'pro';
        }
        else if (apiKey.includes('ent')) {
            tierName = 'enterprise';
        }
        const policy = route.override_policy ?? config.tiers[tierName] ?? config.tiers['free'];
        return {
            clientId: `key_${apiKey}`,
            tier: tierName,
            policy,
            source: 'api_key',
        };
    }
    // Priority 2: Authorization: Bearer <JWT>
    const jwtSub = extractJwtSub(authHeader);
    if (jwtSub && (route.identity_source === 'jwt' || !route.identity_source)) {
        const policy = route.override_policy ?? config.tiers['free'];
        return {
            clientId: `jwt_${jwtSub}`,
            tier: 'free',
            policy,
            source: 'jwt',
        };
    }
    // Priority 3: Client IP
    const clientIp = extractClientIp(req, config.server.trusted_proxies);
    const policy = route.override_policy ?? config.tiers['free'];
    return {
        clientId: `ip_${clientIp}`,
        policy,
        source: 'ip',
    };
}
//# sourceMappingURL=identity.js.map