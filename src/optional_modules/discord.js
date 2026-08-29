const https = require('https');
const http = require('http');
const { URL } = require('url');

let log = () => {};
try {
  const configModule = require('../../config/config');
  if (configModule && typeof configModule.log === 'function') {
    log = configModule.log;
  }
} catch (_) {}

let config = {};
try {
  const envPath = require('path').join(__dirname, '..', '..', 'config', 'config.env');
  const fs = require('fs');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      const commentIdx = v.indexOf(' #');
      if (commentIdx !== -1) v = v.slice(0, commentIdx).trim();
      v = v.replace(/^["']|["']$/g, '');
      if (k) config[k] = v;
    }
  }
} catch (_) {
}

const webhookUrl = (config && config.discord_webhook_url) || process.env.discord_webhook_url || null;

function sendDiscordEmbed(embed) {
  if (!webhookUrl) return;

  const payload = JSON.stringify({ embeds: [embed] });

  try {
    const url = new URL(webhookUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });
    req.on('error', (e) => log('warn', `Discord webhook error: ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) {
    log('warn', `Discord webhook failed: ${e.message}`);
  }
}

function fetchLocalStats(cfg, cb) {
  try {
    const port = Number(cfg?.port || 3004);
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stats', timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { cb(null, JSON.parse(data)); } catch (e) { cb(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); cb(new Error('stats timeout')); });
    req.on('error', (e) => cb(e));
  } catch (e) { cb(e); }
}

function shortAddr(a) {
  return (a || '').length > 20 ? a.slice(0, 8) + '...' + a.slice(-6) : a || 'unknown';
}

function notifyNewBlock(block, cfg) {
  if (!webhookUrl || !block) return;

  const nodeName = cfg?.nodeName || cfg?.nodeUrl || 'Node';
  const height = block.height || 0;
  const hash = (block.hash || '').slice(0, 16);
  const txCount = block.tx_count || 0;
  const ts = new Date(block.timestamp * 1000).toLocaleString('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  let topField = null;
  const rewards = Array.isArray(block.rewards) ? block.rewards.slice() : [];
  if (rewards.length > 0) {
    rewards.sort((a, b) => (Number(b.share_pct) || 0) - (Number(a.share_pct) || 0));
    const totalCc = rewards.reduce((s, r) => s + (Number(r.reward_cc) || 0) / 1e18, 0);
    const lines = rewards.slice(0, 3).map((r) => {
      const cc = ((Number(r.reward_cc) || 0) / 1e18).toFixed(4);
      const pct = Number(r.share_pct) || 0;
      const d = r.deadline != null ? ` · d=${r.deadline}s` : '';
      return `\`${shortAddr(r.miner)}\` — ${pct.toFixed(1)}% (${cc} CC)${d}`;
    });
    if (rewards.length > 3) lines.push(`*+${rewards.length - 3} other(s)*`);
    topField = { name: 'Top Shares', value: lines.join('\n'), inline: false };
    var totalRewardStr = `${totalCc.toFixed(4)} CC`;
  }

  const winnerDeadline = block.winner_proof && block.winner_proof.deadline != null
    ? `${block.winner_proof.deadline}s` : null;
  const rewardValue = totalRewardStr
    || `${((Number(block.reward_cc) || 0) / 1e18).toFixed(2)} CC`;

  const embed = {
    title: `Block #${height} Mined`,
    color: 0x09ff00,
    fields: [
      { name: 'Hash', value: `\`${hash}\``, inline: true },
      { name: 'Miner', value: `\`${shortAddr(block.miner)}\``, inline: true },
      { name: 'Reward', value: rewardValue, inline: true },
      { name: 'Txs', value: String(txCount), inline: true },
      { name: 'Node', value: nodeName, inline: true },
    ],
    timestamp: new Date(block.timestamp * 1000).toISOString(),
  };
  if (winnerDeadline) embed.fields.push({ name: 'Winning Deadline', value: winnerDeadline, inline: true });
  if (topField) embed.fields.push(topField);

  fetchLocalStats(cfg, (err, st) => {
    if (!err && st) {
      if (st.capacity_gb != null) {
        embed.fields.push({
          name: 'Network Storage',
          value: `${Number(st.capacity_gb).toFixed(1)} GB · ${st.plots_count ?? '?'} plots`,
          inline: true,
        });
      }
      if (st.base_target != null) {
        const bt = Number(st.base_target);
        embed.fields.push({
          name: 'Base Target',
          value: bt >= 1e9 ? `${(bt / 1e9).toFixed(2)}G` : String(st.base_target),
          inline: true,
        });
      }
      if (st.supply != null && st.max_supply != null) {
        const pct = (Number(st.supply) / Number(st.max_supply) * 100);
        embed.fields.push({
          name: 'Supply',
          value: `${(Number(st.supply) / 1e18).toFixed(0)} CC (${pct.toFixed(6)}%)`,
          inline: true,
        });
      }
      if (st.blocks_to_halving != null) {
        embed.fields.push({ name: 'Next Halving', value: `in ${st.blocks_to_halving} blocks`, inline: true });
      }
      if (st.height != null) {
        embed.fields.push({ name: 'Chain Height', value: String(st.height), inline: true });
      }
    }
    sendDiscordEmbed(embed);
  });
}

function notifyNewProof(miner, plotid, deadline, result) {
  if (!webhookUrl) return;

  const embed = {
    title: 'New Proof Submitted',
    color: 0x09ff00,
    fields: [
      { name: 'Miner', value: `\`${miner}\``, inline: true },
      { name: 'Plot ID', value: `\`${plotid}\``, inline: true },
      { name: 'Deadline', value: String(deadline), inline: true },
      { name: 'Result', value: result, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };

  sendDiscordEmbed(embed);
}

module.exports = { notifyNewBlock, notifyNewProof };