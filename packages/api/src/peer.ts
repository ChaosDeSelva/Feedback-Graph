import { BlockList, isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

const unmapped = (address: string) => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/** A real loopback socket peer: only a process on the API's own host (outside Docker, or inside its container). */
export function loopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const a = unmapped(address);
  return a === '::1' || /^127(?:\.\d{1,3}){3}$/.test(a);
}

/**
 * Peers a tokenless API may answer: loopback, or an address on one of the API's own networks. Behind Docker's published
 * port the browser and agents on this machine arrive from the bridge gateway, which is on the container's network; a LAN
 * client whose address Docker preserves is not. The Host header plays no part: any client can send `Host: localhost`.
 */
export function localPeers(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): (address: string | undefined) => boolean {
  const nets = new BlockList();
  for (const info of Object.values(interfaces).flat()) {
    // Link-local IPv6 is every interface's own segment, not a network the published port arrives on.
    if (!info?.cidr || info.internal || /^fe80:/i.test(info.address)) continue;
    const [base, prefix] = info.cidr.split('/');
    nets.addSubnet(base, Number(prefix), info.family === 'IPv6' ? 'ipv6' : 'ipv4');
  }
  return (address) => {
    if (!address) return false;
    if (loopbackPeer(address)) return true;
    const a = unmapped(address);
    const family = isIP(a);
    return family !== 0 && nets.check(a, family === 6 ? 'ipv6' : 'ipv4');
  };
}
