// Ordem de exibição no painel. Registrar aqui é tudo o que um módulo novo precisa no lado compartilhado.
import { registerModule, moduleDefs } from '../registry.ts';
import { header } from './m01-header.ts';
import { categoryTabs } from './m02-category-tabs.ts';
import { gallery } from './m03-gallery.ts';
import { share } from './m04-share.ts';
import { coupons } from './m05-coupons.ts';
import { cartIncentive } from './m06-cart-incentive.ts';
import { reviews } from './m07-reviews.ts';
import { videoCards } from './m08-video-cards.ts';
import { miniPlayer } from './m09-mini-player.ts';
import { assistant } from './m10-assistant.ts';
import { sizeGuide } from './m11-size-guide.ts';
import { delivery } from './m12-delivery.ts';
import { cookieNotice } from './m13-cookie-notice.ts';

if (!moduleDefs().length) {
  for (const def of [header, categoryTabs, gallery, share, coupons, cartIncentive, reviews, videoCards, miniPlayer, assistant, sizeGuide, delivery, cookieNotice]) {
    registerModule(def);
  }
}

export { moduleDefs };
