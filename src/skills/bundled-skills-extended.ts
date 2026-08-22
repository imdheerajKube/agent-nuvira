/**
 * Extended Bundled Skills — Additional skills for comprehensive coverage.
 *
 * Categories: DevOps Advanced, Security Advanced, Data Engineering,
 * Cloud Architecture, Testing, Documentation, and more.
 */

import type { Skill } from '../learning/skill-types.js';

const EXTENDED_CREATED_AT = 1_756_000_000_001;

// ─── DevOps Advanced ──────────────────────────────────────────────────────

export const BUNDLED_SKILL_ID_CICD_ADVANCED = 'skill-cicd-advanced';
export const BUNDLED_SKILL_ID_INFRA_MONITORING = 'skill-infra-monitoring';
export const BUNDLED_SKILL_ID_COST_OPTIMIZATION = 'skill-cost-optimization';
export const BUNDLED_SKILL_ID_DISASTER_RECOVERY = 'skill-disaster-recovery';
export const BUNDLED_SKILL_ID_CAPACITY_PLANNING = 'skill-capacity-planning';

export const cicdAdvancedSkill: Skill = {
  id: BUNDLED_SKILL_ID_CICD_ADVANCED,
  name: 'cicd-advanced',
  description:
    'Advanced CI/CD pipelines: multi-stage builds, canary deployments, rollback strategies, artifact management, and pipeline optimization. Use when building sophisticated deployment pipelines.',
  version: '1.0.0',
  goalPattern: 'CI CD pipeline advanced canary deployment rollback artifact optimization multi-stage',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map the pipeline requirements: what CI system (GitHub Actions, GitLab CI, Jenkins)? What deployment targets? What rollback strategy? What artifact storage?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design the advanced pipeline:\n1. Multi-stage: build → test → stage → canary → production\n2. Canary: deploy to small percentage, monitor, gradually increase\n3. Rollback: automatic on failure, manual override\n4. Artifacts: versioned builds, signed releases\n5. Optimization: parallel jobs, caching, matrix builds\n6. Security: SAST, DAST, dependency scanning',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement the pipeline:\n1. Create multi-stage workflow\n2. Add canary deployment logic\n3. Implement rollback triggers\n4. Configure artifact storage\n5. Add security scanning\n6. Test with dry-run deployments',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: pipeline stages execute in order, canary works, rollback triggers on failure, artifacts are stored correctly.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['cicd', 'pipeline', 'canary', 'rollback', 'deployment'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const infraMonitoringSkill: Skill = {
  id: BUNDLED_SKILL_ID_INFRA_MONITORING,
  name: 'infra-monitoring',
  description:
    'Infrastructure monitoring setup: Prometheus, Grafana, alerting rules, dashboards, and SLI/SLO tracking. Use when setting up observability for production systems.',
  version: '1.0.0',
  goalPattern: 'infrastructure monitoring prometheus grafana alerting dashboard SLI SLO observability',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map the infrastructure: what services need monitoring? What metrics are critical? What alert channels exist? What dashboards are needed?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design the monitoring stack:\n1. Metrics: Prometheus for collection, custom exporters\n2. Dashboards: Grafana for visualization\n3. Alerting: Alertmanager with routing rules\n4. SLIs: availability, latency, error rate, throughput\n5. SLOs: target thresholds for each SLI\n6. On-call: PagerDuty/OpsGenie integration',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement monitoring:\n1. Deploy Prometheus with scrape configs\n2. Create Grafana dashboards\n3. Configure alerting rules\n4. Set up SLI/SLO tracking\n5. Test alerts with simulated failures\n6. Document runbooks',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: metrics are collected, dashboards show data, alerts fire on thresholds, SLOs are tracked.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['monitoring', 'prometheus', 'grafana', 'alerting', 'observability'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const costOptimizationSkill: Skill = {
  id: BUNDLED_SKILL_ID_COST_OPTIMIZATION,
  name: 'cost-optimization',
  description:
    'Cloud cost optimization: right-sizing, reserved instances, spot instances, resource tagging, and cost monitoring. Use when optimizing cloud spending.',
  version: '1.0.0',
  goalPattern: 'cloud cost optimization right-sizing reserved instances spot resource tagging monitoring',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map the cloud usage: what provider (AWS, GCP, Azure)? What services are running? What are the current costs? What usage patterns exist?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design cost optimization:\n1. Right-sizing: analyze utilization, recommend smaller instances\n2. Reserved: purchase reserved instances for steady workloads\n3. Spot: use spot instances for fault-tolerant workloads\n4. Tagging: enforce resource tagging for cost allocation\n5. Monitoring: set up cost alerts and budgets\n6. Cleanup: identify and remove unused resources',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement optimization:\n1. Analyze current resource usage\n2. Identify right-sizing opportunities\n3. Purchase reserved instances\n4. Configure spot instance pools\n5. Set up cost alerts\n6. Create cleanup automation',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: costs are reduced, right-sizing is applied, spot instances are running, alerts are configured.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['cost', 'optimization', 'cloud', 'aws', 'right-sizing'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const disasterRecoverySkill: Skill = {
  id: BUNDLED_SKILL_ID_DISASTER_RECOVERY,
  name: 'disaster-recovery',
  description:
    'Disaster recovery planning: backup strategies, failover mechanisms, RTO/RPO targets, and DR testing. Use when planning for system resilience.',
  version: '1.0.0',
  goalPattern: 'disaster recovery backup failover RTO RPO DR planning resilience',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map the critical systems: what services need DR? What are the RTO/RPO targets? What backup infrastructure exists?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design DR strategy:\n1. Backup: frequency, retention, cross-region replication\n2. Failover: active-passive vs active-active\n3. RTO/RPO: define targets for each system\n4. Testing: regular DR drills\n5. Documentation: runbooks for failover\n6. Monitoring: backup verification alerts',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement DR:\n1. Configure backup schedules\n2. Set up cross-region replication\n3. Implement failover mechanisms\n4. Create DR runbooks\n5. Conduct DR test\n6. Document procedures',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: backups are running, failover works, RTO/RPO targets are met, DR test was successful.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['disaster-recovery', 'backup', 'failover', 'resilience'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const capacityPlanningSkill: Skill = {
  id: BUNDLED_SKILL_ID_CAPACITY_PLANNING,
  name: 'capacity-planning',
  description:
    'Capacity planning: load testing, performance baselines, growth forecasting, and scaling strategies. Use when planning for system growth.',
  version: '1.0.0',
  goalPattern: 'capacity planning load testing performance baseline growth forecasting scaling',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map the current capacity: what are the performance baselines? What is the expected growth? What are the scaling limits?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design capacity plan:\n1. Baselines: current performance metrics\n2. Load testing: simulate expected traffic\n3. Forecasting: project growth over 6-12 months\n4. Scaling: horizontal vs vertical scaling\n5. Thresholds: when to trigger scaling\n6. Budget: cost of additional capacity',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement capacity planning:\n1. Establish performance baselines\n2. Run load tests\n3. Create growth forecast\n4. Implement auto-scaling\n5. Set up scaling alerts\n6. Document capacity plan',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: baselines are accurate, load tests pass, scaling works, forecast is realistic.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['capacity', 'planning', 'load-testing', 'scaling'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

// ─── Security Advanced ────────────────────────────────────────────────────

export const BUNDLED_SKILL_ID_INCIDENT_RESPONSE = 'skill-incident-response';
export const BUNDLED_SKILL_ID_FORENSICS = 'skill-forensics';
export const BUNDLED_SKILL_ID_THREAT_INTEL = 'skill-threat-intel';
export const BUNDLED_SKILL_ID_SECURE_CODING = 'skill-secure-coding';
export const BUNDLED_SKILL_ID_CONTAINER_SECURITY = 'skill-container-security';

export const incidentResponseSkill: Skill = {
  id: BUNDLED_SKILL_ID_INCIDENT_RESPONSE,
  name: 'incident-response',
  description:
    'Incident response procedures: detection, containment, eradication, recovery, and post-incident review. Use when responding to security incidents.',
  version: '1.0.0',
  goalPattern: 'incident response security breach detection containment eradication recovery review',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Assess the incident: what happened? What systems are affected? What is the impact? What is the timeline?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Plan incident response:\n1. Detection: identify the incident type and scope\n2. Containment: isolate affected systems\n3. Eradication: remove the threat\n4. Recovery: restore systems to normal\n5. Review: conduct post-incident analysis\n6. Lessons: document improvements',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Execute incident response:\n1. Document incident details\n2. Isolate affected systems\n3. Collect evidence\n4. Remove threat\n5. Restore from backups\n6. Conduct post-mortem',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: incident is contained, systems are restored, documentation is complete, improvements are identified.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['incident-response', 'security', 'breach', 'forensics'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const forensicsSkill: Skill = {
  id: BUNDLED_SKILL_ID_FORENSICS,
  name: 'forensics',
  description:
    'Digital forensics: evidence collection, chain of custody, analysis, and reporting. Use when investigating security incidents.',
  version: '1.0.0',
  goalPattern: 'digital forensics evidence collection chain of custody analysis reporting investigation',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Identify evidence sources: what systems need forensic analysis? What evidence exists? What is the chain of custody?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Plan forensic investigation:\n1. Evidence collection: disk images, memory dumps, logs\n2. Chain of custody: document handling\n3. Analysis: timeline, artifacts, indicators\n4. Reporting: findings and recommendations\n5. Legal: ensure admissibility\n6. Preservation: maintain evidence integrity',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Conduct investigation:\n1. Create forensic images\n2. Document chain of custody\n3. Analyze evidence\n4. Create timeline\n5. Write report\n6. Preserve evidence',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: evidence is preserved, chain of custody is documented, analysis is thorough, report is complete.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['forensics', 'investigation', 'evidence', 'security'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const threatIntelSkill: Skill = {
  id: BUNDLED_SKILL_ID_THREAT_INTEL,
  name: 'threat-intel',
  description:
    'Threat intelligence: IOC collection, threat hunting, attribution, and intelligence sharing. Use when gathering and analyzing threat intelligence.',
  version: '1.0.0',
  goalPattern: 'threat intelligence IOC collection hunting attribution sharing analysis',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Identify threat landscape: what threats are relevant? What intelligence sources exist? What IOCs are known?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design threat intel program:\n1. Collection: feeds, sources, automation\n2. Analysis: IOC enrichment, correlation\n3. Hunting: proactive threat searching\n4. Attribution: identify threat actors\n5. Sharing: STIX/TAXII, ISACs\n6. Integration: SIEM, SOAR integration',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement threat intel:\n1. Set up intelligence feeds\n2. Automate IOC collection\n3. Create hunting queries\n4. Analyze collected intelligence\n5. Share with community\n6. Integrate with security tools',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: feeds are active, IOCs are enriched, hunting is effective, intelligence is shared.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['threat-intelligence', 'IOC', 'hunting', 'attribution'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const secureCodingSkill: Skill = {
  id: BUNDLED_SKILL_ID_SECURE_CODING,
  name: 'secure-coding',
  description:
    'Secure coding practices: input validation, output encoding, authentication, authorization, and cryptographic operations. Use when implementing security controls.',
  version: '1.0.0',
  goalPattern: 'secure coding input validation output encoding authentication authorization cryptography',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Identify security requirements: what threats exist? What controls are needed? What compliance standards apply?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design secure coding practices:\n1. Input validation: whitelist, sanitize, validate\n2. Output encoding: prevent injection\n3. Authentication: MFA, password policies\n4. Authorization: RBAC, least privilege\n5. Cryptography: encryption, hashing, key management\n6. Error handling: secure error messages',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement secure coding:\n1. Add input validation\n2. Implement output encoding\n3. Configure authentication\n4. Set up authorization\n5. Implement cryptographic operations\n6. Add secure error handling',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: input is validated, output is encoded, authentication works, authorization is enforced.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['secure-coding', 'security', 'authentication', 'cryptography'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const containerSecuritySkill: Skill = {
  id: BUNDLED_SKILL_ID_CONTAINER_SECURITY,
  name: 'container-security',
  description:
    'Container security: image scanning, runtime protection, network policies, and secrets management. Use when securing containerized applications.',
  version: '1.0.0',
  goalPattern: 'container security image scanning runtime protection network policies secrets management',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Assess container security: what images are used? What runtime policies exist? What network controls are in place?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design container security:\n1. Image scanning: CVE scanning, base image updates\n2. Runtime: seccomp, AppArmor, read-only rootfs\n3. Network: network policies, service mesh mTLS\n4. Secrets: vault integration, sealed secrets\n5. Compliance: CIS benchmarks, OPA policies\n6. Monitoring: runtime threat detection',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement container security:\n1. Enable image scanning in CI/CD\n2. Apply runtime policies\n3. Configure network policies\n4. Set up secrets management\n5. Implement OPA policies\n6. Enable runtime monitoring',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: images are scanned, runtime is protected, network is restricted, secrets are managed.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['container-security', 'docker', 'kubernetes', 'secrets'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

// ─── Data Engineering ─────────────────────────────────────────────────────

export const BUNDLED_SKILL_ID_DATA_QUALITY = 'skill-data-quality';
export const BUNDLED_SKILL_ID_DATA_GOVERNANCE = 'skill-data-governance';
export const BUNDLED_SKILL_ID_STREAMING_DATA = 'skill-streaming-data';
export const BUNDLED_SKILL_ID_DATA_LINEAGE = 'skill-data-lineage';

export const dataQualitySkill: Skill = {
  id: BUNDLED_SKILL_ID_DATA_QUALITY,
  name: 'data-quality',
  description:
    'Data quality management: validation rules, profiling, cleansing, and monitoring. Use when ensuring data accuracy and completeness.',
  version: '1.0.0',
  goalPattern: 'data quality validation profiling cleansing monitoring accuracy completeness',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Assess data quality: what data sources exist? What quality issues are known? What validation rules are needed?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design data quality framework:\n1. Profiling: understand data characteristics\n2. Validation: define quality rules\n3. Cleansing: fix quality issues\n4. Monitoring: track quality metrics\n5. Alerting: notify on quality degradation\n6. Reporting: quality dashboards',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement data quality:\n1. Profile data sources\n2. Define validation rules\n3. Implement cleansing logic\n4. Set up monitoring\n5. Configure alerts\n6. Create quality dashboards',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: data is profiled, rules are defined, cleansing works, monitoring is active.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['data-quality', 'validation', 'profiling', 'cleansing'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const dataGovernanceSkill: Skill = {
  id: BUNDLED_SKILL_ID_DATA_GOVERNANCE,
  name: 'data-governance',
  description:
    'Data governance: policies, access controls, compliance, and stewardship. Use when implementing data governance frameworks.',
  version: '1.0.0',
  goalPattern: 'data governance policies access control compliance stewardship GDPR CCPA',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Assess governance needs: what regulations apply? What data is sensitive? What access controls exist?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design governance framework:\n1. Policies: data handling, retention, disposal\n2. Access: RBAC, data classification\n3. Compliance: GDPR, CCPA, HIPAA\n4. Stewardship: ownership, accountability\n5. Cataloging: data inventory, metadata\n6. Auditing: access logs, compliance checks',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement governance:\n1. Define data policies\n2. Implement access controls\n3. Configure compliance rules\n4. Assign data stewards\n5. Create data catalog\n6. Set up auditing',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: policies are defined, access is controlled, compliance is met, catalog is complete.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['data-governance', 'compliance', 'GDPR', 'CCPA'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const streamingDataSkill: Skill = {
  id: BUNDLED_SKILL_ID_STREAMING_DATA,
  name: 'streaming-data',
  description:
    'Streaming data architectures: Kafka, Kinesis, event sourcing, and real-time processing. Use when building real-time data pipelines.',
  version: '1.0.0',
  goalPattern: 'streaming data kafka kinesis event sourcing real-time processing pipeline',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map streaming requirements: what data streams exist? What throughput is needed? What latency targets exist?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design streaming architecture:\n1. Ingestion: Kafka, Kinesis, Pub/Sub\n2. Processing: Flink, Spark Streaming, Kafka Streams\n3. Storage: data lake, time-series DB\n4. Serving: real-time queries, materialized views\n5. Monitoring: lag, throughput, errors\n6. Schema: Avro, Protobuf, schema registry',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement streaming pipeline:\n1. Set up message broker\n2. Create stream processors\n3. Configure storage sinks\n4. Implement real-time queries\n5. Add monitoring\n6. Test with sample data',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: data flows correctly, processing is real-time, storage is optimized, monitoring is active.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['streaming', 'kafka', 'kinesis', 'real-time'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

export const dataLineageSkill: Skill = {
  id: BUNDLED_SKILL_ID_DATA_LINEAGE,
  name: 'data-lineage',
  description:
    'Data lineage tracking: origin, transformations, dependencies, and impact analysis. Use when tracking data flow through systems.',
  version: '1.0.0',
  goalPattern: 'data lineage tracking origin transformations dependencies impact analysis',
  steps: [
    {
      agentType: 'context-gatherer',
      description:
        'Map data flow: what are the data sources? What transformations occur? What are the downstream consumers?',
      dependsOn: [],
    },
    {
      agentType: 'planner',
      description:
        'Design lineage tracking:\n1. Capture: metadata at each stage\n2. Model: directed acyclic graph\n3. Visualize: lineage graphs\n4. Impact: analyze downstream effects\n5. Compliance: regulatory requirements\n6. Integration: catalog, governance',
      dependsOn: ['step-0'],
    },
    {
      agentType: 'runner',
      description:
        'Implement lineage tracking:\n1. Instrument data pipelines\n2. Capture metadata\n3. Build lineage graph\n4. Create visualization\n5. Implement impact analysis\n6. Integrate with catalog',
      dependsOn: ['step-1'],
    },
    {
      agentType: 'reviewer',
      description:
        'Verify: lineage is captured, graph is accurate, impact analysis works, integration is complete.',
      dependsOn: ['step-2'],
    },
  ],
  parameters: [],
  tags: ['data-lineage', 'metadata', 'impact-analysis', 'compliance'],
  sourceTrajectoryIds: ['bundled'],
  qualityScore: 0.85,
  usageCount: 0,
  createdAt: EXTENDED_CREATED_AT,
  lastUsedAt: EXTENDED_CREATED_AT,
};

// ─── Export all extended skills ───────────────────────────────────────────

export const EXTENDED_SKILLS: Skill[] = [
  // DevOps Advanced
  cicdAdvancedSkill,
  infraMonitoringSkill,
  costOptimizationSkill,
  disasterRecoverySkill,
  capacityPlanningSkill,
  // Security Advanced
  incidentResponseSkill,
  forensicsSkill,
  threatIntelSkill,
  secureCodingSkill,
  containerSecuritySkill,
  // Data Engineering
  dataQualitySkill,
  dataGovernanceSkill,
  streamingDataSkill,
  dataLineageSkill,
];
