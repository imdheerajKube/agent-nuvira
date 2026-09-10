"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = App;
const react_1 = require("react");
const react_router_dom_1 = require("react-router-dom");
const api_1 = require("./api");
const Layout_1 = __importDefault(require("./components/Layout"));
const Overview_1 = __importDefault(require("./components/Overview"));
const DAGView_1 = __importDefault(require("./components/DAGView"));
const CostDashboard_1 = __importDefault(require("./components/CostDashboard"));
const BenchmarkCharts_1 = __importDefault(require("./components/BenchmarkCharts"));
const HealthPanel_1 = __importDefault(require("./components/HealthPanel"));
const ModelsPanel_1 = __importDefault(require("./components/ModelsPanel"));
const RoutingInsightsPanel_1 = __importDefault(require("./components/RoutingInsightsPanel"));
const RequestsPanel_1 = __importDefault(require("./components/RequestsPanel"));
const TracePanel_1 = __importDefault(require("./components/TracePanel"));
const AdminPanel_1 = __importDefault(require("./components/AdminPanel"));
const AgentHub_1 = __importDefault(require("./components/AgentHub"));
const TasksPage_1 = __importDefault(require("./components/TasksPage"));
const ChatPage_1 = __importDefault(require("./components/ChatPage"));
const EvalsPage_1 = __importDefault(require("./components/EvalsPage"));
const GatewayPage_1 = __importDefault(require("./components/GatewayPage"));
const PlatformsPage_1 = __importDefault(require("./components/PlatformsPage"));
const BedrockOnboarding_1 = __importDefault(require("./components/BedrockOnboarding"));
const ContactsPage_1 = __importDefault(require("./components/ContactsPage"));
const ModelTimeline_1 = __importDefault(require("./components/ModelTimeline"));
function App() {
    const [data, setData] = (0, react_1.useState)(null);
    const [connected, setConnected] = (0, react_1.useState)(false);
    const [lastUpdated, setLastUpdated] = (0, react_1.useState)('--');
    const handleData = (0, react_1.useCallback)((d) => {
        setData(d);
        setLastUpdated(new Date().toLocaleTimeString());
    }, []);
    const handleConnection = (0, react_1.useCallback)((c) => {
        setConnected(c);
    }, []);
    (0, react_1.useEffect)(() => {
        // Fetch initial data
        api_1.dashboardAPI.fetchAll().then((d) => {
            if (d)
                handleData(d);
        });
        // Subscribe to SSE updates
        const unsubData = api_1.dashboardAPI.subscribe(handleData);
        const unsubConn = api_1.dashboardAPI.onConnectionChange(handleConnection);
        api_1.dashboardAPI.connect();
        return () => {
            unsubData();
            unsubConn();
            api_1.dashboardAPI.disconnect();
        };
    }, [handleData, handleConnection]);
    return (<Layout_1.default connected={connected} lastUpdated={lastUpdated}>
      <react_router_dom_1.Routes>
        {/* Phase 5 — Chat is the front door; Overview (and every other room)
            stays reachable as a panel, never required. */}
        <react_router_dom_1.Route path="/" element={<ChatPage_1.default />}/>
        <react_router_dom_1.Route path="/overview" element={<Overview_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/chat" element={<react_router_dom_1.Navigate to="/" replace/>}/>
        <react_router_dom_1.Route path="/dag" element={<DAGView_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/costs" element={<CostDashboard_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/benchmarks" element={<BenchmarkCharts_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/models" element={<ModelsPanel_1.default />}/>
        <react_router_dom_1.Route path="/models/timeline" element={<ModelTimeline_1.default />}/>
        <react_router_dom_1.Route path="/routing" element={<RoutingInsightsPanel_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/requests" element={<RequestsPanel_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/traces" element={<TracePanel_1.default />}/>
        <react_router_dom_1.Route path="/hub" element={<AgentHub_1.default />}/>
        <react_router_dom_1.Route path="/tasks" element={<TasksPage_1.default />}/>
        <react_router_dom_1.Route path="/chat" element={<ChatPage_1.default />}/>
        <react_router_dom_1.Route path="/evals" element={<EvalsPage_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/platforms" element={<PlatformsPage_1.default />}/>
        <react_router_dom_1.Route path="/bedrock" element={<BedrockOnboarding_1.default canWrite={true} sessionExpired={(msg) => console.error(msg)}/>}/>
        <react_router_dom_1.Route path="/contacts" element={<ContactsPage_1.default />}/>
        <react_router_dom_1.Route path="/gateway" element={<GatewayPage_1.default />}/>
        <react_router_dom_1.Route path="/system" element={<HealthPanel_1.default data={data}/>}/>
        <react_router_dom_1.Route path="/admin" element={<AdminPanel_1.default />}/>
        <react_router_dom_1.Route path="*" element={<react_router_dom_1.Navigate to="/" replace/>}/>
      </react_router_dom_1.Routes>
    </Layout_1.default>);
}
