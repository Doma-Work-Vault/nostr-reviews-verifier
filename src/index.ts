import { ReviewStateDO } from './durable-object';
import { createReviewsAttestationApp } from './app';

const app = createReviewsAttestationApp();

export { ReviewStateDO };

export default {
	fetch: app.fetch.bind(app)
};

