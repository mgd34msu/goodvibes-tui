import { PlanDashboardPanel } from '../../../panels/plan-dashboard-panel.ts';
import { runBasePanelContractSuite, EMPTY_PLAN_DASHBOARD_QUERY } from './_shared.ts';

runBasePanelContractSuite({
  label: 'PlanDashboardPanel (no plan)',
  factory: () => new PlanDashboardPanel(EMPTY_PLAN_DASHBOARD_QUERY),
});
