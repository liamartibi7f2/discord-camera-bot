require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const PENDING_TIMERS = new Map();
const CAMERA_WATCHERS = new Map();     // userId -> setTimeout for camera-on duration tracking
const SAFE_USERS = new Set();           // userId who had cam on >= MIN_CAM_DURATION_MS
const GRACE_PERIOD_MS = 30_000;
const MIN_CAM_DURATION_MS = 300_000;   // 5 minutes of camera-on to earn "safe" status

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot is online! Logged in as ${c.user.tag}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId = newState.member?.id;
  if (!userId) return;

  const targetChannelId = process.env.TARGET_CHANNEL_ID;
  const joinedChannelId = newState.channelId;

  // If a specific channel is configured, only act on that channel
  if (targetChannelId && joinedChannelId !== targetChannelId) {
    return;
  }

  // ── User JOINED a voice channel ──
  if (!oldState.channelId && joinedChannelId) {
    SAFE_USERS.delete(userId);
    cancelCameraWatch(userId);
    if (newState.selfVideo) {
      // Joined with camera already on — cancel timer, start watching duration
      startCameraWatch(newState);
    } else {
      startTimer(newState);
    }
    return;
  }

  // ── User SWITCHED voice channels ──
  if (oldState.channelId && joinedChannelId && oldState.channelId !== joinedChannelId) {
    SAFE_USERS.delete(userId);
    cancelTimer(userId);
    cancelCameraWatch(userId);
    startTimer(newState);
    return;
  }

  // ── User turned ON camera ──
  if (newState.selfVideo && !oldState.selfVideo && joinedChannelId) {
    cancelTimer(userId);
    // Start watching how long they keep it on
    startCameraWatch(newState);
    return;
  }

  // ── User turned OFF camera ──
  if (!newState.selfVideo && oldState.selfVideo && joinedChannelId) {
    // If they already earned safe status, don't start a new timer
    if (SAFE_USERS.has(userId)) {
      console.log(`✅ [${newState.member?.user?.tag}] Turned cam off but has safe status — no action`);
      return;
    }
    // They turned cam off before hitting MIN_CAM_DURATION_MS — start kick timer
    console.log(`⚠️ [${newState.member?.user?.tag}] Turned cam off before safe threshold — starting kick timer`);
    startTimer(oldState);
    return;
  }

  // ── User LEFT voice channel ──
  if (oldState.channelId && !joinedChannelId) {
    cancelTimer(userId);
    cancelCameraWatch(userId);
    SAFE_USERS.delete(userId);
    return;
  }
});

function startTimer(voiceState) {
  const userId = voiceState.id;
  cancelTimer(userId);

  console.log(`⏳ [${voiceState.member?.user?.tag}] Joined voice — starting ${GRACE_PERIOD_MS / 1000}s timer`);

  const timer = setTimeout(async () => {
    try {
      const member = await voiceState.guild.members.fetch(userId);

      if (!member.voice.channelId) {
        console.log(`[${member.user?.tag}] Left before timer expired — no action`);
        return;
      }

      if (member.voice.selfVideo || SAFE_USERS.has(userId)) {
        console.log(`✅ [${member.user?.tag}] Camera is on or safe — all good`);
        return;
      }

      console.log(`🚫 [${member.user?.tag}] Camera off after ${GRACE_PERIOD_MS / 1000}s — disconnecting`);
      // Announce the kick in the configured text channel, or system channel
      try {
        const guild = member.guild;
        const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;
        const target = announceChannelId
          ? guild.channels.cache.get(announceChannelId)
          : guild.systemChannel;
        if (target?.isTextBased?.()) {
          await target.send(`HoàngBunny skill: Bunny thần chưởng!!!`);
          console.log(`📢 Sent kick message to #${target.name}`);
        } else {
          console.log(`⚠️ No suitable text channel found to announce kick`);
        }
      } catch (_) { /* best-effort */ }
      await member.voice.disconnect('Camera not turned on within 30 seconds');
    } catch (err) {
      console.error(`❌ Error disconnecting user ${userId}:`, err.message);
    } finally {
      PENDING_TIMERS.delete(userId);
    }
  }, GRACE_PERIOD_MS);

  PENDING_TIMERS.set(userId, timer);
}

function cancelTimer(userId) {
  if (PENDING_TIMERS.has(userId)) {
    clearTimeout(PENDING_TIMERS.get(userId));
    PENDING_TIMERS.delete(userId);
  }
}

/**
 * Start watching a user's camera duration.
 * If they keep their camera on for MIN_CAM_DURATION_MS, mark them safe.
 */
function startCameraWatch(voiceState) {
  const userId = voiceState.id;
  cancelCameraWatch(userId);

  console.log(`📷 [${voiceState.member?.user?.tag}] Camera turned on — watching for ${MIN_CAM_DURATION_MS / 1000}s safe threshold`);

  const timer = setTimeout(async () => {
    try {
      const member = await voiceState.guild.members.fetch(userId);
      if (!member.voice.channelId) {
        console.log(`[${member.user?.tag}] Left before camera watch expired`);
        return;
      }
      // Mark them as safe — they had cam on long enough
      SAFE_USERS.add(userId);
      console.log(`🛡️ [${member.user?.tag}] Had camera on for ${MIN_CAM_DURATION_MS / 1000}s (5 min) — marked safe`);
    } catch (err) {
      console.error(`❌ Error in camera watch for ${userId}:`, err.message);
    } finally {
      CAMERA_WATCHERS.delete(userId);
    }
  }, MIN_CAM_DURATION_MS);

  CAMERA_WATCHERS.set(userId, timer);
}

function cancelCameraWatch(userId) {
  if (CAMERA_WATCHERS.has(userId)) {
    clearTimeout(CAMERA_WATCHERS.get(userId));
    CAMERA_WATCHERS.delete(userId);
  }
}

client.login(process.env.BOT_TOKEN).catch((err) => {
  console.error('❌ Failed to login:', err.message);
  process.exit(1);
});
