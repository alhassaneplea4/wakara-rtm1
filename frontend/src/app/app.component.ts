import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IdleService } from './core/idle.service';
import { PageMetaService } from './core/page-meta.service';
import { ConsentBannerComponent } from './shared/consent-banner.component';
import { ToastHostComponent } from './shared/ui';

@Component({
    selector: 'app-root',
    imports: [RouterOutlet, ToastHostComponent, ConsentBannerComponent],
    template: `<router-outlet /><wk-toasts /><wk-consent-banner />`
})
export class AppComponent {
  constructor() {
    inject(PageMetaService);          // titles, descriptions, robots and canonical address of each page
    inject(IdleService).start();     // end of an online session left without activity
  }
}
