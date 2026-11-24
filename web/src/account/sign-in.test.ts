// @vitest-environment node
//
// Signing in from a tab (docs/phase-18-trousseau-identite.md, analysis
// 18i.2; ADR-0041; docs/protocol/06-identity.md, ID-25): the window opened
// at once on a prepared attempt, the return taken for the attempt in
// progress only and once, a late answer ignored and its token ended, the
// token forgotten before logout, the deadline on the device's clock.
import { describe, expect, test } from "vitest";
import { type SignInAttempt, TOKEN_MS } from "../../lib/src/index.js";
import {
  ACCOUNT_CHANNEL,
  SIGN_IN_CHANNEL,
  SignIn,
  type SignInOptions,
} from "./sign-in.js";
import {
  ChannelBus,
  PendingGateway,
  codeOf,
  knownAttempt,
  memoryAccountLocal,
  requestOf,
  sessionAnswer,
} from "./test-support.js";

const GATEWAY = "https://accounts.example";

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}

interface Setup {
  signIn: SignIn;
  gateway: PendingGateway;
  bus: ChannelBus;
  local: ReturnType<typeof memoryAccountLocal>;
  opened: string[];
  timers: { at: number; run: () => void; live: boolean }[];
  clock: { now: number };
  attempts: SignInAttempt[];
  options: SignInOptions;
}

/** A tab, its gateway healthy unless said otherwise. */
async function setup(
  overrides: {
    healthy?: boolean;
    local?: ReturnType<typeof memoryAccountLocal>;
    bus?: ChannelBus;
    now?: number;
    client?: "obsidian";
  } = {},
): Promise<Setup> {
  const gateway = new PendingGateway();
  const bus = overrides.bus ?? new ChannelBus();
  const local = overrides.local ?? memoryAccountLocal();
  const opened: string[] = [];
  const timers: Setup["timers"] = [];
  const clock = { now: overrides.now ?? 1_000_000 };
  const attempts: SignInAttempt[] = [];
  // Made beforehand: WebCrypto's digest ends when it ends, not when the
  // test says.
  const pool = await Promise.all([1, 2, 3, 4].map(() => knownAttempt()));
  const options: SignInOptions = {
    gateway: GATEWAY,
    local,
    fetch: gateway.fetch,
    setTimer: (run, ms) => {
      const timer = { at: clock.now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    now: () => clock.now,
    openWindow: (url) => opened.push(url),
    channel: (name) => bus.channel(name),
    ...(overrides.client && { client: overrides.client }),
    newAttempt: async () => {
      const attempt = pool.shift();
      if (!attempt) throw new Error("no attempt left");
      attempts.push(attempt);
      return attempt;
    },
  };
  const opening = SignIn.open(options);
  await settle();
  const health = gateway.take("/accounts/health");
  if (overrides.healthy === false) health.fail();
  else health.answer(new Response("{}", { status: 200 }));
  const signIn = await opening;
  await settle();
  return {
    signIn,
    gateway,
    bus,
    local,
    opened,
    timers,
    clock,
    attempts,
    options,
  };
}

/** The return of the window for `request`, from `/auth-return`. */
function returned(bus: ChannelBus, request: string, code = codeOf(7)) {
  bus.postFromElsewhere(SIGN_IN_CHANNEL, { code, request });
  bus.deliverAll();
}

describe("signing in from the plugin (ID-41)", () => {
  test("the window asks for its return by obsidian://, recent or not", async () => {
    const { signIn, opened } = await setup({ client: "obsidian" });
    signIn.start();
    signIn.cancel();
    await settle();
    signIn.start({ recent: true });
    const [first, second] = opened.map((url) => new URL(url).searchParams);
    expect(first?.getAll("client")).toEqual(["obsidian"]);
    expect(second?.getAll("client")).toEqual(["obsidian"]);
    expect(second?.has("fresh")).toBe(true);
  });

  test("a tab asks for none", async () => {
    const { signIn, opened } = await setup();
    signIn.start();
    expect(new URL(opened[0] as string).searchParams.has("client")).toBe(false);
  });
});

describe("signing in from a tab", () => {
  test("ready once the gateway answers; unavailable if it doesn't", async () => {
    const { signIn } = await setup();
    expect(signIn.state()).toEqual({ kind: "signed-out", ready: true });
    const { signIn: down } = await setup({ healthy: false });
    expect(down.state()).toEqual({ kind: "unavailable" });
  });

  test("the click opens the window at once, on the prepared attempt", async () => {
    const { signIn, opened, attempts } = await setup();
    signIn.start();
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0] as string);
    expect(url.origin + url.pathname).toBe(`${GATEWAY}/accounts/login`);
    expect(url.searchParams.get("request")).toBe(attempts[0]?.request);
    expect(url.searchParams.get("challenge")).toBe(attempts[0]?.challenge);
    expect(signIn.state()).toEqual({ kind: "pending" });
  });

  test("CN1: the code of the attempt in progress is exchanged once, with its verifier", async () => {
    const { signIn, opened, gateway, bus, local, clock, attempts } =
      await setup();
    signIn.start();
    const request = requestOf(opened[0] as string);
    // Another attempt's return, and malformed ones: nothing.
    returned(bus, "f".repeat(32));
    bus.postFromElsewhere(SIGN_IN_CHANNEL, { request, code: "short" });
    bus.postFromElsewhere(SIGN_IN_CHANNEL, "anything");
    bus.deliverAll();
    await settle();
    expect(gateway.calls).toEqual([]);
    returned(bus, request);
    returned(bus, request);
    await settle();
    const exchange = gateway.take("/accounts/session");
    expect(JSON.parse(String(exchange.init?.body))).toEqual({
      code: codeOf(7),
      verifier: attempts[0]?.verifier,
    });
    expect(gateway.calls).toEqual([]);
    const sentAt = clock.now;
    clock.now += 5_000;
    exchange.answer(sessionAnswer(codeOf(9)));
    await settle();
    expect(signIn.state()).toEqual({
      kind: "signed-in",
      name: "Ada",
      email: "ada@example.org",
      issuer: "https://idp.example",
      sub: "u-1",
    });
    // ID-25: twelve hours from the sending, on this device's clock.
    expect(local.stored).toEqual({
      gateway: GATEWAY,
      token: codeOf(9),
      deadline: sentAt + TOKEN_MS,
      name: "Ada",
      email: "ada@example.org",
      issuer: "https://idp.example",
      sub: "u-1",
    });
    // The other tabs told.
    expect(bus.queue).toEqual([
      expect.objectContaining({ name: ACCOUNT_CHANNEL }),
    ]);
  });

  test("ID-28: a recent sign-in when wanted, recent 600 s from the sending", async () => {
    const s = await setup();
    let wanted = true;
    s.options.recent = () => wanted;
    s.signIn.start();
    expect(new URL(s.opened[0] as string).search).toMatch(/&fresh$/);
    returned(s.bus, requestOf(s.opened[0] as string));
    await settle();
    const sentAt = s.clock.now;
    s.clock.now += 5_000;
    s.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(9)));
    await settle();
    expect(s.local.stored?.recentUntil).toBe(sentAt + 600_000);
    // Not wanted: an ordinary sign-in, an ordinary token.
    wanted = false;
    s.signIn.start();
    expect(new URL(s.opened[1] as string).search).not.toContain("fresh");
    returned(s.bus, requestOf(s.opened[1] as string), codeOf(8));
    await settle();
    s.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(10)));
    await settle();
    expect(s.local.stored?.token).toBe(codeOf(10));
    expect(s.local.stored?.recentUntil).toBeUndefined();
  });

  // Analysis 18o.3, IC1: « Confirmer » is recent, whatever `recent` says;
  // `recent()` says whether the token kept is.
  test("IC1: a sign-in asked recent is, whatever is wanted; recent() until its end", async () => {
    const s = await setup();
    s.options.recent = () => false;
    expect(s.signIn.recent()).toBe(false);
    s.signIn.start({ recent: true });
    expect(new URL(s.opened[0] as string).search).toMatch(/&fresh$/);
    returned(s.bus, requestOf(s.opened[0] as string));
    await settle();
    s.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(9)));
    await settle();
    expect(s.signIn.recent()).toBe(true);
    s.clock.now += 600_000;
    expect(s.signIn.recent()).toBe(false);
  });

  test("a refusal of the provider, or of the exchange, says so", async () => {
    const { signIn, opened, gateway, bus } = await setup();
    signIn.start();
    bus.postFromElsewhere(SIGN_IN_CHANNEL, {
      error: "denied",
      request: requestOf(opened[0] as string),
    });
    bus.deliverAll();
    await settle();
    expect(signIn.state()).toEqual({
      kind: "signed-out",
      ready: true,
      reason: "denied",
    });
    signIn.start();
    returned(bus, requestOf(opened[1] as string));
    await settle();
    gateway
      .take("/accounts/session")
      .answer(new Response(null, { status: 401 }));
    await settle();
    expect(signIn.state()).toEqual({
      kind: "signed-out",
      ready: true,
      reason: "failed",
    });
  });

  test("CN2: cancelled during the exchange, its token is ended and never kept", async () => {
    const { signIn, opened, gateway, bus, local } = await setup();
    signIn.start();
    returned(bus, requestOf(opened[0] as string));
    await settle();
    const exchange = gateway.take("/accounts/session");
    signIn.cancel();
    expect(signIn.state()).toEqual({ kind: "signed-out", ready: true });
    exchange.answer(sessionAnswer(codeOf(9)));
    await settle();
    expect(local.stored).toBeUndefined();
    expect(signIn.state()).toEqual({ kind: "signed-out", ready: true });
    const logout = gateway.take("/accounts/logout");
    expect(logout.init?.headers).toEqual({
      Authorization: `Bearer ${codeOf(9)}`,
    });
  });

  test("CN4: a token kept, then forgotten because given up, is announced so", async () => {
    // Found by the scenario: another tab read the token between its
    // keeping and its forgetting, and was never told.
    const bus = new ChannelBus();
    const local = memoryAccountLocal();
    let release = () => {};
    const keep = local.keepSignedIn;
    local.keepSignedIn = async (account) => {
      await keep(account);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const one = await setup({ bus, local });
    const two = await setup({ bus, local });
    one.signIn.start();
    returned(bus, requestOf(one.opened[0] as string));
    await settle();
    one.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(9)));
    await settle();
    // Written, not yet told: the other tab reads it meanwhile.
    bus.postFromElsewhere(ACCOUNT_CHANNEL, { changed: true });
    bus.deliverAll();
    await settle();
    expect(two.signIn.state()).toMatchObject({ kind: "signed-in" });
    one.signIn.cancel();
    release();
    await settle();
    expect(local.stored).toBeUndefined();
    bus.deliverAll();
    await settle();
    expect(two.signIn.state()).toEqual({ kind: "signed-out", ready: true });
  });

  test("CN4: a token given up after it replaced another leaves the tab showing what is kept", async () => {
    // Found by the scenario: signed in with one token, a second sign-in
    // cancelled while its token was being kept — over the first.
    const local = memoryAccountLocal();
    let release = () => {};
    const keep = local.keepSignedIn;
    const tab = await setup({ local });
    tab.signIn.start();
    returned(tab.bus, requestOf(tab.opened[0] as string));
    await settle();
    tab.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(9)));
    await settle();
    expect(tab.signIn.state()).toMatchObject({ kind: "signed-in" });
    local.keepSignedIn = async (account) => {
      await keep(account);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    tab.signIn.start();
    returned(tab.bus, requestOf(tab.opened[1] as string));
    await settle();
    tab.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(10)));
    await settle();
    tab.signIn.cancel();
    release();
    await settle();
    expect(local.stored).toBeUndefined();
    expect(tab.signIn.state()).toEqual({ kind: "signed-out", ready: true });
  });

  test("CN4: a tab that opens has the others read again", async () => {
    // Found by the scenario: a tab reloaded while its token was being
    // written never told of it; the page that opens in its place does.
    const bus = new ChannelBus();
    const local = memoryAccountLocal();
    const one = await setup({ bus, local });
    local.stored = {
      gateway: GATEWAY,
      token: codeOf(9),
      deadline: one.clock.now + 1000,
      name: "Ada",
      email: null,
      issuer: "i",
      sub: "s",
    };
    await setup({ bus, local });
    bus.deliverAll();
    await settle();
    expect(one.signIn.state()).toMatchObject({ kind: "signed-in", sub: "s" });
  });

  test("two clicks: only the last attempt counts", async () => {
    const { signIn, opened, gateway, bus } = await setup();
    signIn.start();
    await settle();
    signIn.start();
    returned(bus, requestOf(opened[0] as string));
    await settle();
    expect(gateway.calls).toEqual([]);
    returned(bus, requestOf(opened[1] as string));
    await settle();
    gateway.take("/accounts/session");
  });

  test("CN3: signing out forgets the token before telling the gateway", async () => {
    const { signIn, opened, gateway, bus, local } = await setup();
    signIn.start();
    returned(bus, requestOf(opened[0] as string));
    await settle();
    gateway.take("/accounts/session").answer(sessionAnswer(codeOf(9)));
    await settle();
    const out = signIn.signOut();
    await settle();
    const logout = gateway.take("/accounts/logout");
    expect(local.stored).toBeUndefined();
    expect(signIn.state()).toEqual({ kind: "signed-out", ready: true });
    logout.fail();
    await out;
  });

  test("CN4: what another tab keeps is shown; a token that expired is not", async () => {
    const bus = new ChannelBus();
    const local = memoryAccountLocal();
    const one = await setup({ bus, local });
    const two = await setup({ bus, local });
    one.signIn.start();
    returned(bus, requestOf(one.opened[0] as string));
    await settle();
    one.gateway.take("/accounts/session").answer(sessionAnswer(codeOf(9)));
    await settle();
    bus.deliverAll();
    await settle();
    expect(two.signIn.state()).toMatchObject({ kind: "signed-in" });
    // The deadline, on each tab's clock.
    const deadline = local.stored?.deadline as number;
    two.clock.now = deadline;
    for (const timer of two.timers.filter((t) => t.live && t.at <= deadline)) {
      timer.live = false;
      timer.run();
    }
    await settle();
    expect(two.signIn.state()).toEqual({
      kind: "signed-out",
      ready: true,
      reason: "expired",
    });
    expect(local.stored).toBeUndefined();
  });

  test("a token kept but expired opens signed out, and is forgotten", async () => {
    const local = memoryAccountLocal();
    local.stored = {
      gateway: GATEWAY,
      token: codeOf(9),
      deadline: 500,
      name: "Ada",
      email: null,
      issuer: "i",
      sub: "s",
    };
    const { signIn } = await setup({ local, now: 500 });
    expect(signIn.state()).toEqual({ kind: "signed-out", ready: true });
    expect(local.stored).toBeUndefined();
  });

  test("a token of another gateway is not this one's", async () => {
    const local = memoryAccountLocal();
    local.stored = {
      gateway: "https://other.example",
      token: codeOf(9),
      deadline: 10_000_000,
      name: "Ada",
      email: null,
      issuer: "i",
      sub: "s",
    };
    const { signIn } = await setup({ local });
    expect(signIn.state()).toEqual({ kind: "signed-out", ready: true });
  });

  test("closed, it hears nothing more", async () => {
    const { signIn, opened, gateway, bus } = await setup();
    signIn.start();
    signIn.close();
    returned(bus, requestOf(opened[0] as string));
    await settle();
    expect(gateway.calls).toEqual([]);
  });
});
