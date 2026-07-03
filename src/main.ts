import "./style.css";
import { initGameSentry } from "@genex-ai/embed-sdk/sentry";
import { initEmbed, waitForAuth, getColyseusAuth } from "@genex-ai/embed-sdk";
import { connect } from "@genex-ai/multiplayer";
import { GENEX } from "./genex.config";
import { makeRenderer, buildWorld } from "./scene";
import { loadAssets } from "./assets";
import { Game } from "./game";
import { $ } from "./util";
import type { PlayerNet } from "./config";

// Crash reporting first, then embed identity — before any other game code.
initGameSentry({ slug: GENEX.slug });
initEmbed({
  slug: GENEX.slug,
  apiUrl: GENEX.apiUrl,
  dashboardOrigins: GENEX.dashboardOrigins,
});

async function boot(): Promise<void> {
  const canvas = $<HTMLCanvasElement>("#game");
  const renderer = makeRenderer(canvas);
  const assets = await loadAssets(renderer);
  const world = buildWorld(assets);
  const game = new Game(renderer, world, assets);
  game.start(); // scene renders immediately; identity gate covers it until signed in

  try {
    const { user } = await waitForAuth();
    const room = await connect<PlayerNet>({
      url: GENEX.colyseusUrl,
      room: GENEX.slug,
      name: user.name,
      auth: getColyseusAuth()!,
    });
    game.attachRoom(room, user.name);
  } catch {
    // Session blocked or relay rejected — the SDK overlay owns that UX.
  }
}

void boot();
