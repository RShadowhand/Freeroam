import { apiGet, apiJson } from './http';

export const getWeather = () => apiGet('/api/weather');
export const setAreaWeather = (area, body) => apiJson(`/api/weather/${encodeURIComponent(area)}`, 'POST', body);
