import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastHostComponent } from './shared/ui';

@Component({
  selector: 'app-root', standalone: true,
  imports: [RouterOutlet, ToastHostComponent],
  template: `<router-outlet /><wk-toasts />`,
})
export class AppComponent {}
