import type { ChildProcess } from 'child_process';

export const ANVIL_RPC: string;
export const ROUTER: `0x${string}`;
export const STAKING: `0x${string}`;
export const ADMIN: `0x${string}`;
export const DISTRIBUTOR: `0x${string}`;
export const DISTRIBUTOR_PRIVATE_KEY: `0x${string}`;
export const REWARDS_DISTRIBUTOR_ROLE: `0x${string}`;
export const anvilChain: any;

export function startAnvil(): Promise<ChildProcess>;
export function deployV2Contract(
  privateKey?: `0x${string}` | string,
): `0x${string}`;
export function configureV2Contract(address: `0x${string}`): Promise<void>;
export function createAnvilClients(): {
  publicClient: any;
  walletClient: any;
  account: any;
};
