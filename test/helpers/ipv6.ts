import net from "node:net";

/**
 * Whether this host can listen on the IPv6 loopback. Container runtimes (CI's included) often run without IPv6, where
 * the tests that connect over it cannot run.
 */
export async function hasIpv6Loopback(): Promise<boolean> {
    const probe: net.Server = net.createServer();
    return new Promise((resolve) => {
        probe.once("error", () => resolve(false));
        probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
}
