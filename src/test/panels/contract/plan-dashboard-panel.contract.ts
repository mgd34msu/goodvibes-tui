import { PlanDashboardPanel } from '../../../panels/plan-dashboard-panel.ts';
import { runBasePanelContractSuite, EMPTY_PLAN_DASHBOARD_QUERY, EMPTY_WORKFLOW_EVENT_FEED } from './_shared.ts';

runBasePanelContractSuite({
  label: 'PlanDashboardPanel (no plan)',
  factory: () => new PlanDashboardPanel(EMPTY_WORKFLOW_EVENT_FEED, { planManager: EMPTY_PLAN_DASHBOARD_QUERY }),
});
