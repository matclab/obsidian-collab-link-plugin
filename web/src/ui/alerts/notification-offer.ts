import type { DeviceNotifications } from "../../push/device.js";
import type { DeviceAttempt, DeviceOffer } from "./alerts-invite.js";
import type { AlertPermission, Attention } from "./alerts.js";

/** The notifications offered to a view (ADR-0060 §1, §4): the permission
 * and this device in this document, shared by the document menu and the
 * invitation (NI4), each listener told of every change. This
 * device is what the browser says, or what a gesture made it; the outcome
 * of a gesture is apart, so that a failure never says this device off.
 * Gone quiet once closed. */
export class NotificationOffer {
  private permissionNow: AlertPermission;
  private deviceNow: DeviceOffer;
  private attemptNow: DeviceAttempt = "idle";
  private control: DeviceNotifications | undefined;
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly attention:
      | Pick<Attention, "permission" | "request">
      | undefined,
    device: Promise<DeviceNotifications | undefined> | undefined,
  ) {
    this.permissionNow = attention?.permission() ?? "unsupported";
    this.deviceNow = device ? "pending" : "unsupported";
    void device?.then(async (found) => {
      if (this.closed) return;
      if (!found) return this.set("unsupported");
      this.control = found;
      this.set("checking");
      const state = await found.state().catch(() => "off" as const);
      // A gesture that ended meanwhile made it: this read is older.
      if (this.deviceNow === "checking") this.set(state);
    });
  }

  permission(): AlertPermission {
    return this.permissionNow;
  }

  device(): DeviceOffer {
    return this.deviceNow;
  }

  attempt(): DeviceAttempt {
    return this.attemptNow;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** On a gesture only (ADR-0060 §1). */
  async request(): Promise<void> {
    const answer = await this.attention?.request();
    if (this.closed || answer === undefined) return;
    this.permissionNow = answer;
    this.tell();
  }

  /** On a gesture only: subscribing asks for the permission too. */
  async setDevice(on: boolean): Promise<void> {
    const control = this.control;
    if (!control || this.closed) return;
    this.attemptNow = "busy";
    this.tell();
    const outcome = await (on ? control.enable() : control.disable());
    if (this.closed) return;
    this.permissionNow = this.attention?.permission() ?? this.permissionNow;
    // Refused, or not signed: nothing written, this device as it was.
    if (outcome === "on" || outcome === "off") {
      this.deviceNow = outcome;
      this.attemptNow = "idle";
    } else {
      this.attemptNow = outcome;
    }
    this.tell();
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private set(device: DeviceOffer): void {
    if (this.closed) return;
    this.deviceNow = device;
    this.tell();
  }

  private tell(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
