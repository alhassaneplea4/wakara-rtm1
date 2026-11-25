import { Injectable, signal } from '@angular/core';

const KEY = 'wk.notify.desktop';

/** What the browser says about notifications, plus the user's own choice made in the notification menu. */
export type DesktopState = 'unsupported' | 'blocked' | 'on' | 'off';

/**
 * Native browser notifications (the pop-up shown by the system, even when another tab or window is in front).
 * The browser asks the user for permission, and may only be asked from a click: {@link toggle} is called from the
 * notification menu. Nothing is shown while the user is looking at the application (the in-page message and the
 * chime are enough), and a refused permission is never asked again.
 */
@Injectable({ providedIn: 'root' })
export class NotifyDesktopService {
  readonly state = signal<DesktopState>(NotifyDesktopService.compute());

  /** Switch on (asking the browser's permission the first time) or off. Returns a message when it cannot be switched on. */
  async toggle(): Promise<string> {
    if (this.state() === 'unsupported') return '';
    if (this.state() === 'on') { this.store(false); return ''; }
    if (this.state() === 'blocked') {
      return 'Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur (icône à gauche de l\'adresse).';
    }
    let permission: NotificationPermission = Notification.permission;
    if (permission === 'default') {
      try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
    }
    if (permission !== 'granted') { this.state.set(NotifyDesktopService.compute()); return 'Notifications non autorisées par le navigateur.'; }
    this.store(true);
    this.show('Notifications activées', 'Vous serez averti ici des nouveaux dossiers, même hors de cet onglet.', 'wk-test', () => undefined, true);
    return '';
  }

  /** Show one notification when the user is away from the application (or `force`). `onClick` brings them to the work. */
  show(title: string, body: string, tag: string, onClick: () => void, force = false) {
    if (this.state() !== 'on') return;
    if (!force && !document.hidden && document.hasFocus()) return;
    try {
      const n = new Notification(title, { body, tag, icon: 'assets/icon-192.png' });   // same tag: a newer one replaces the older
      n.onclick = () => { window.focus(); onClick(); n.close(); };
    } catch { /* some mobile browsers only allow notifications through a service worker: the in-page alert remains */ }
  }

  private store(on: boolean) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* the choice lasts for this visit only */ }
    this.state.set(on ? 'on' : 'off');
  }

  private static compute(): DesktopState {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    let chosen = false;
    try { chosen = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
    return Notification.permission === 'granted' && chosen ? 'on' : 'off';
  }
}
