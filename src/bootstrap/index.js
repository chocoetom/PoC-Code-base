#!/usr/bin/env node
const { loadConfig, log } = require('../../config/config');
const { ChocoNode } = require('./node');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';

  console.log(`
${CYAN}      _                     _           _      
  ___| |__   ___   ___ ___ | |__  _   _| |__   
 / __| '_ \\ / _ \\ / __/ _ \\| '_ \\| | | | '_ \\  
| (__| | | | (_) | (_| (_) | | | | |_| | |_) | 
 \\___|_| |_|\\___/ \\___\\___/|_| |_|\\__,_|_.__/  
                                               
 _          _                  _               
| |__   ___| |_ __    ___  ___| |_ _   _ _ __  
| '_ \\ / _ \\ | '_ \\  / __|/ _ \\ __| | | | '_ \\ 
| | | |  __/ | |_) | \\__ \\  __/ |_| |_| | |_) |
|_| |_|\\___|_| .__/  |___/\\___|\\__|\\__,_| .__/ 
             |_|                        |_|    ${RESET}

  ${BOLD}ChocoNode — PoC Testnet Node${RESET}

  ${GREEN}USAGE${RESET}
    node src/index.js              Start the node
    node src/index.js --help       Show this help

  ${GREEN}ENVIRONMENT VARIABLES${RESET}
    ${DIM}PORT${RESET}              3001                      HTTP port
    ${DIM}MINER_ADDRESS${RESET}     0x...                     Block signing address
    ${DIM}LOG_LEVEL${RESET}         info                      Log level (trace/debug/info/warn/error)
    ${DIM}DATA_DIR${RESET}          ./node-data               Data directory
    ${DIM}PLOTS_DIR${RESET}         ./plots                   Plot directory
    ${DIM}ADMIN_TOKEN${RESET}       ...                       Admin API token

  ${GREEN}CONFIG FILES${RESET}
    config/config.env               KEY=VALUE overrides
    config/node_config.json         Auto-generated, overrides defaults

  ${GREEN}EXAMPLES${RESET}
    node src/index.js
    PORT=3002 node src/index.js

${DIM}                    _                  _(_)_                          wWWWw   _
      @@@@       (_)@(_)   vVVVv     _     @@@@  (___) _(_)_
     @@()@@ wWWWw  (_)\\    (___)   _(_)_  @@()@@   Y  (_)@(_)
      @@@@  (___)     \`|/    Y    (_)@(_)  @@@@   \\|/   (_)\\
       /      Y       \\|    \\|/    /(_)    \\|      |/      |
    \\ |     \\ |/       | / \\ | /  \\|/       |/    \\|      \\|/
jgs \\\\|//   \\\\|///  \\\\\\|//\\\\\\|/// \\|///  \\\\\\|//  \\\\|//  \\\\\\|//${RESET}
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  `);
  process.exit(0);
}

const cfg = loadConfig();
if (cfg.nodeUrl) log('info', `public url: ${cfg.nodeUrl}`);
const node = new ChocoNode(cfg);
node.start();
