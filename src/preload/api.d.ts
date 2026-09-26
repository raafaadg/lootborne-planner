import type { PlannerApi } from '../shared/contracts';

declare global {
  interface Window {
    planner: PlannerApi;
  }
}
