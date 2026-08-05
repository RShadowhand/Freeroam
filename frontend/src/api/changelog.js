import { apiGet } from './http';

export const getChangelog = () => apiGet('/api/changelog');
