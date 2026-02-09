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

  export default class Hyperswarm extends EventEmitter {
    keyPair: { publicKey: Buffer; secretKey: Buffer };
    connections: Set<Duplex>;

    join(topic: Buffer, opts?: JoinOptions): Discovery;
    leave(topic: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
  }
}
