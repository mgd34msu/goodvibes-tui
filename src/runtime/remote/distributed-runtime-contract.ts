import { getPeerContract, type PeerContractManifest } from '@pellux/goodvibes-sdk-beta/contracts';

export function getDistributedNodeHostContract(): PeerContractManifest {
  return getPeerContract();
}
