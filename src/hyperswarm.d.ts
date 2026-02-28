declare module "hyperswarm" {
  import { EventEmitter } from "node:events";
  import type { Duplex } from "node:stream";

  export interface PeerInfo {
    publicKey: Buffer;
    topics?: Buffer[];
  }

  export interface JoinOptions {
    server?: boolean;
    client?: boolean;
  }

  export interface Discovery {
    flushed(): Promise<void>;
  }

  export interface BootstrapNode {
    host: string;
    port: number;
  }

  export interface HyperswarmOptions {
    /** Custom DHT bootstrap nodes. Useful for local/LAN peer discovery. */
    bootstrap?: BootstrapNode[];
    /** Seed for deterministic key pair generation. */
    seed?: Buffer;
    /** Maximum total peer connections. */
    maxPeers?: number;
    /** DHT listen port. */
    port?: number;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);

    keyPair: { publicKey: Buffer; secretKey: Buffer };
    connections: Set<Duplex>;

    join(topic: Buffer, opts?: JoinOptions): Discovery;
    leave(topic: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
  }
}
