// Copyright © 2022 TBCO
// License: Apache-2.0

/**
 * Configuration for `bcc-node`
 *
 * @packageDocumentation
 */

import path from 'path';
import getPort from 'get-port';

import { StartService, ShutdownMethod, cleanShutdownFD } from './service';
import { FilePath, DirPath, makeRtsArgs } from './common';

/**
 * Definition of a `bcc-node` network.
 */
export interface BccNetwork {
  /**
   * The YAML configuration file for bcc-node.
   */
  configFile: FilePath;
  /**
   * Network topology data to pass to bcc-node.
   */
  topologyFile: FilePath;
  /**
   * Path to the Cole genesis file in JSON format.
   * This is required for testnet and staging but not mainnet.
   * It is used to configure the parameters of bcc-wallet.
   * It should match the ColeGenesisFile configured in the bcc-node YAML file.
   * Note that the Cole-era genesis file is always required,
   * even if currently in Sophie era.
   */
  genesisFile?: FilePath;
}

/** Predefined networks. */
export const networks: { [propName: string]: BccNetwork } = {
  mainnet: {
    configFile: 'configuration.json',
    topologyFile: 'topology.json',
  },
  testnet: {
    configFile: 'configuration.json',
    topologyFile: 'topology.json',
    genesisFile: 'genesis-cole.json',
  },
  staging: {
    configFile: 'configuration.json',
    topologyFile: 'topology.json',
    genesisFile: 'genesis-cole.json',
  },
};

/**
 * The command-line arguments which can be supplied to `bcc-node`.
 * These values are derived from [[BccNodeConfig]].
 *
 * @internal
 */
export interface BccNodeArgs {
  /**
   * Filename for the socket file to use for communicating with the
   * node.
   */
  socketFile: FilePath;

  /**
   * The path to a file describing the topology.
   * Topology is ...
   */
  topologyFile: FilePath;

  /** Directory where the state is stored. */
  databaseDir: DirPath;

  /** Path to the delegation certificate. */
  delegationCertificate?: string;

  /** Path to the signing key. */
  signingKey?: string;

  /** Path to the KES signing key. */
  kesKey?: string;

  /** Path to the VRF signing key. */
  vrfKey?: string;

  /** Path to the delegation certificate */
  operationalCertificate?: string;

  /** Configures the address to bind for P2P communication. */
  listen: {
    /** The TCP port for node P2P. */
    port: number;
    /** Optionally limit node P2P to one ipv4 address. */
    address?: string;
    /** Optionally limit node P2P to one ipv6 address. */
    address6?: string;
  };

  /** Configuration file for bcc-node. */
  configFile: FilePath;

  /** Validate all on-disk database files. */
  validateDb?: boolean;

  /** GHC runtime system options. */
  rtsOpts?: string[];

  /**
   * Extra arguments to add to the `bcc-node` command line.
   */
  extra?: string[];
}

/**
 * Configuration parameters for starting bcc-node.
 *
 * These parameters can be set in [[LaunchConfig.nodeConfig]].
 */
export interface BccNodeConfig {
  kind: 'sophie';

  /** Directory containing configurations for all networks.
   * Defaults to the using the `$BCC_NODE_CONFIGS`
   * environment variable if not supplied.
   */
  configurationDir: DirPath;

  /** Path to the delegation certificate. The delegation certificate allows the delegator
   * (the issuer of said certificate) to give his/her own block signing rights to somebody
   * else (the delegatee). The delegatee can then sign blocks on behalf of the delegator.
   * */
  delegationCertificate?: string;

  /** Network parameters. */
  network: BccNetwork;

  /** Path to the KES signing key. */
  kesKey?: string;

  /** Path to the VRF signing key. */
  vrfKey?: string;

  /** Path to the delegation certificate */
  operationalCertificate?: string;

  /** Path to the signing key. */
  signingKey?: string;

  /**
   * Filename for the socket to use for communicating with the
   * node. Optional -- will be set automatically if not provided.
   */
  socketFile?: FilePath;

  /**
   * GHC runtime system options for bcc-node.
   * Can be used for debugging, tuning performance, etc.
   * See: https://downloads.haskell.org/ghc/8.10.7/docs/html/users_guide/runtime_control.html#setting-rts-options-on-the-command-line
   */
  rtsOpts?: string[];
}

let pipeCounter = 0;

/**
 * Allocate a name for the pipe used to communicate with the node on
 * Windows. The network name and PID are used to ensure different
 * applications do not cross their streams.
 *
 * The name also includes a per-process counter, mostly so that
 * integration tests do not conflict with each other.
 *
 * @param networkName: which network to put in the pipe name.
 * @return a [Pipe Name](https://docs.microsoft.com/en-us/windows/win32/ipc/pipe-names)
 */
function windowsPipeName(networkName: string): string {
  return `\\\\.\\pipe\\bcc-node-${networkName}.${
    process.pid
  }.${pipeCounter++}`;
}

/**
 * Convert a [[BccNodeConfig]] into command-line arguments
 * ([[BccNodeArgs]]) for `bcc-node`.
 */
function makeArgs(
  stateDir: DirPath,
  config: BccNodeConfig,
  networkName: string,
  listenPort: number
): BccNodeArgs {
  // Set default value for socketFile, and update config.
  let socketFile = config.socketFile;
  if (!socketFile) {
    if (process.platform === 'win32') {
      config.socketFile = socketFile = windowsPipeName(networkName);
    } else {
      socketFile = 'bcc-node.socket'; // relative to working directory
      config.socketFile = path.join(stateDir, socketFile);
    }
  }

  // Update config with predefined network if none provided.
  if (!config.network) {
    if (networks[networkName]) {
      config.network = networks[networkName];
    } else {
      throw new Error(
        `BccNodeConfig does not have a network defined, and ${networkName} is not a recognised network name.`
      );
    }
  }

  // Use $BCC_NODE_CONFIGS/networkName if no configuration
  // directory provided.
  if (!config.configurationDir) {
    const def = process.env.BCC_NODE_CONFIGS;
    if (def) {
      config.configurationDir = path.join(def as string, networkName);
    }
  }

  return {
    socketFile,
    topologyFile: path.join(
      config.configurationDir,
      config.network.topologyFile
    ),
    databaseDir: 'chain', // relative to working directory
    delegationCertificate: config.delegationCertificate,
    listen: {
      port: listenPort,
      // Listen for TCP connections on the loopback interface.
      // We don't want to listen on 0.0.0.0 by default.
      address: '127.0.0.1',
      // Don't listen on IPv6 at all -- this would fail if IPv6 is disabled.
      address6: undefined,
    },
    configFile: path.join(config.configurationDir, config.network.configFile),
    signingKey: config.signingKey,
    kesKey: config.kesKey,
    vrfKey: config.vrfKey,
    rtsOpts: config.rtsOpts,
  };
}

export interface NodeStartService extends StartService {
  /** This will contain the bcc-node socket file path. */
  socketPath: string;

  /** This will contain the TCP port which the bcc-node is listening on. */
  listenPort: number;
}

/**
 * Chooses the command-line arguments for the node.
 *
 * @param stateDir - directory for node storage, specific to the node type and network.
 * @param config - parameters for starting the node.
 * @return the command-line for starting this node.
 */
export async function startBccNode(
  stateDir: DirPath,
  config: BccNodeConfig,
  networkName: string
): Promise<NodeStartService> {
  const listenPort = await getPort();
  const args = makeArgs(stateDir, config, networkName, listenPort);
  return {
    command: 'bcc-node',
    args: [
      'run',
      '--socket-path',
      args.socketFile,
      '--shutdown-ipc',
      '' + cleanShutdownFD,
      '--topology',
      args.topologyFile,
      '--database-path',
      args.databaseDir,
      '--port',
      '' + args.listen.port,
      '--config',
      args.configFile,
    ]
      .concat(args.listen.address ? ['--host-addr', args.listen.address] : [])
      .concat(
        args.listen.address6 ? ['--host-ipv6-addr', args.listen.address6] : []
      )
      .concat(args.validateDb || false ? ['--validate-db'] : [])
      .concat(args.signingKey ? ['--signing-key', args.signingKey] : [])
      .concat(
        args.delegationCertificate
          ? ['--delegation-certificate', args.delegationCertificate]
          : []
      )
      .concat(args.kesKey ? ['--sophie-kes-key', args.kesKey] : [])
      .concat(args.vrfKey ? ['--sophie-vrf-key', args.vrfKey] : [])
      .concat(
        args.operationalCertificate
          ? ['--sophie-operational-certificate', args.operationalCertificate]
          : []
      )
      .concat(makeRtsArgs(args.rtsOpts))
      .concat(args.extra || []),
    shutdownMethod: ShutdownMethod.CloseFD,
    // set working directory to stateDir -- config file may have relative paths for logs.
    cwd: stateDir,
    socketPath: args.socketFile,
    listenPort: args.listen.port,
  };
}