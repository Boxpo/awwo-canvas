import type { ContractField, ContractFieldType } from './nodeContracts';
import type { AgentTemplate } from './agentTemplates';

const field = (
  id: string,
  label: string,
  required: boolean,
  placeholder: string,
  help: string,
  type: ContractFieldType = 'markdown',
): ContractField => ({ id, label, type, required, value: '', placeholder, help });

function template(spec: Omit<AgentTemplate, 'input' | 'output'>): AgentTemplate {
  return {
    ...spec,
    input: [spec.inputs[0].id, spec.inputs[0].label],
    output: [spec.outputs[0].id, spec.outputs[0].label],
    persona: `${spec.persona}\n\nWorkflow:\n${spec.workflow.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nAcceptance criteria:\n${spec.checklist.map(item => `- ${item}`).join('\n')}\n\nEvidence policy: distinguish verified, unverified, and blocked work. Cite actual checks or files and state any evidence gaps. Never describe a plan, example, or placeholder as a completed result.`,
  };
}

/** English presentation and defaults for newly created nodes. Stable IDs mirror the Chinese set. */
export const EN_AGENT_TEMPLATES: ReadonlyArray<AgentTemplate> = [
  template({
    id: 'general', title: 'Custom Agent', subtitle: 'Turn a clear goal into an accepted delivery', tag: 'AGENT',
    persona: 'Own the independent task defined by the user. Clarify the deliverable and boundaries before executing it step by step. Do not expand the scope without authorization.',
    inputs: [
      field('brief', 'Task brief', true, 'Goal:\nDeliverable:\nDefinition of done:', 'Describe the problem to solve and the concrete result that should be delivered.'),
      field('constraints', 'Constraints and preferences', false, 'Must follow:\nExclude:\nWriting style:', 'Add scope, format, or collaboration constraints.'),
      field('references', 'References', false, 'Links or file paths', 'Cite available sources. Material that was not provided must not be treated as read.', 'file'),
    ],
    outputs: [
      field('result', 'Delivered result', true, 'Completed work:\nDelivery location:\nVerification:', 'Summarize actual work and evidence that can be checked.'),
      field('followups', 'Follow-ups', false, 'Open decisions:\nRecommended next step:', 'Record decisions for the user or work for another Agent.'),
    ],
    workflow: ['Confirm the goal, inputs, and definition of done', 'Break down and execute the work within the authorized scope', 'Check the result and record evidence and follow-ups'],
    checklist: ['The delivery addresses the stated goal', 'Sources and generated files are traceable', 'Unfinished and unverified work is explicitly identified'],
    starterPrompts: [
      { label: 'Plan the task', prompt: 'Use the current inputs to outline the goal, execution steps, and acceptance criteria. List only missing information that truly blocks progress.' },
      { label: 'Start execution', prompt: 'Execute the task step by step. Preserve delivery locations and verification records, then distinguish completed, unverified, and pending work.' },
    ],
    deliverableTitle: 'Task delivery', emptyTitle: 'Start with a clear outcome', emptyDescription: 'Fill in the task brief, then let this Agent follow the work from planning through delivery.',
  }),
  template({
    id: 'frontend', title: 'Frontend development', subtitle: 'Build an operable interface from APIs and designs', tag: 'FRONTEND',
    persona: 'Own frontend pages, components, and interactions. Follow the API contract and design constraints. Do not invent API fields or present a static screenshot as a working interface.',
    inputs: [
      field('api', 'API contract', true, 'Endpoints:\nRequest and response fields:\nAuthentication:\nErrors:', 'Usually comes from the backend service. Mark any unresolved endpoints or fields.'),
      field('screens', 'Screens and interactions', false, 'Screens:\nKey actions:\nLoading, empty, and error states:', 'Describe how users finish their task and how exceptional states are communicated.'),
      field('design', 'Design reference', false, 'Design, component library, or screenshot link / path', 'Provide visual and component guidance. State the chosen conventions when no design exists.', 'file'),
      field('assets', 'Copy and asset inventory', false, 'Page copy:\nAsset paths:\nPlacement:', 'Connect a content-production node and reference real copy and assets.'),
    ],
    outputs: [
      field('delivery', 'Interface delivery', true, 'Implemented screens:\nCode location:\nHow to run:\nKnown limitations:', 'State the actual scope, usage, and files for review.'),
      field('preview', 'Preview entry point', false, 'Working preview URL or local entry path', 'Provide only an entry point that exists and state its access requirements.', 'file'),
      field('checks', 'Interaction verification', false, 'Steps:\nObserved result:\nDevices and sizes:\nNot verified:', 'Record actual form, keyboard, responsive, and error-state checks.'),
    ],
    workflow: ['Confirm screen requirements, API fields, and design references', 'Implement components, forms, and loading, empty, and error states', 'Verify key actions, responsive behavior, and keyboard access', 'Deliver code, preview entry point, and verification records'],
    checklist: ['Requests and responses follow the API contract', 'Key user actions work and failures have clear feedback', 'Claimed sizes and keyboard paths have verification records', 'The preview entry point and code location are real and usable'],
    starterPrompts: [
      { label: 'Plan the interface', prompt: 'From the API contract and screen requirements, outline the page structure, component responsibilities, and interaction states. Identify API or design gaps.' },
      { label: 'Build and verify', prompt: 'Implement the current screens and interactions with existing APIs and assets. Verify the main user paths and deliver a runnable entry point with evidence.' },
    ],
    deliverableTitle: 'Interface delivery', emptyTitle: 'Turn requirements into an operable interface', emptyDescription: 'Connect the API contract and design references, then build and verify the interface step by step.',
  }),
  template({
    id: 'backend', title: 'Backend services', subtitle: 'Data models, business rules, and stable APIs', tag: 'BACKEND',
    persona: 'Own business services, data access, and API implementation. Use the data dictionary to define entities and consistency boundaries. Integrate the account, role, and authorization contract supplied by the user-system node.',
    inputs: [
      field('schema', 'Data dictionary', true, 'Entities and fields:\nTypes and constraints:\nRelationships:', 'Usually comes from data governance and forms the basis of API and storage design.'),
      field('rules', 'Business rules', false, 'Actions:\nPreconditions:\nState changes:\nFailure handling:', 'Describe workflows, validation, idempotency, and consistency requirements.'),
      field('systems', 'External dependencies', false, 'Services:\nAPI / event contracts:\nTest method:', 'Include the identity and authorization contract; do not redesign the account system.'),
      field('limits', 'Runtime constraints', false, 'Performance target:\nStorage constraints:\nCompatibility:\nEnvironment:', 'Record confirmed runtime boundaries and leave unknown metrics pending.'),
    ],
    outputs: [
      field('api', 'API contract', true, 'Endpoints and methods:\nRequests / responses:\nValidation and error codes:\nIdentity and authorization:', 'Deliver fields, calling conventions, and errors that frontend clients can consume.'),
      field('implementation', 'Service implementation', false, 'Code location:\nData changes:\nStartup and configuration:\nCompatibility:', 'Describe the actual implementation and required configuration; do not present a design as deployed.'),
      field('checks', 'Service verification', false, 'Scenarios:\nObserved results:\nConcurrency / retry checks:\nNot verified:', 'Record evidence for business rules, error paths, and data consistency.'),
    ],
    workflow: ['Confirm the data dictionary, business rules, and dependency contracts', 'Design APIs, transaction boundaries, and failure handling', 'Implement services and data access, then verify key rules', 'Deliver API contracts, runtime instructions, and test evidence'],
    checklist: ['API fields match the data dictionary', 'Business validation and errors are usable by callers', 'Identity and authorization follow the user-system contract', 'Idempotency, failures, and data changes have corresponding verification'],
    starterPrompts: [
      { label: 'Design the service contract', prompt: 'Use the data dictionary and business rules to design APIs, transaction boundaries, and errors. State dependencies on the user system and other services.' },
      { label: 'Implement the service', prompt: 'Implement the confirmed service contract, verify key rules and failure paths, and deliver API documentation, startup instructions, and observed test results.' },
    ],
    deliverableTitle: 'Service delivery', emptyTitle: 'Define the service contract and boundaries first', emptyDescription: 'Connect the data dictionary, add business rules, then build a backend service that can be verified.',
  }),
  template({
    id: 'data', title: 'Data governance', subtitle: 'Keep definitions, quality, and lineage consistent', tag: 'DATA',
    persona: 'Own business entities, field definitions, sources, and quality rules. Provide traceable definitions to other nodes. When samples are insufficient or sources are unavailable, mark conclusions unverified instead of inferring production distributions.',
    inputs: [
      field('brief', 'Business requirements', true, 'Business scenario:\nCore entities:\nQuestions to answer:', 'Describe the purpose of the data service and concepts that need a shared definition.'),
      field('sources', 'Data sources', false, 'Source systems:\nTables / files:\nUpdate method:\nOwner:', 'List available sources and access conditions. Never put passwords in this form.'),
      field('samples', 'Samples and existing dictionary', false, 'Sample or dictionary file path / link', 'Reference appropriately handled samples that are authorized for this task.', 'file'),
      field('governance', 'Governance boundaries', false, 'Access roles:\nRetention:\nSensitive fields:\nDefinition rules:', 'Define access, quality, and lifecycle constraints.'),
    ],
    outputs: [
      field('schema', 'Data dictionary', true, 'Entities:\nFields / types / required:\nBusiness definitions:\nRelationships and constraints:', 'Deliver consistent, implementable field and relationship definitions to backend services.'),
      field('quality', 'Quality rules and findings', false, 'Rules:\nObserved findings:\nAnomaly sample references:\nRemediation:', 'Distinguish proposed rules from findings based on actual checks.'),
      field('lineage', 'Lineage and governance', false, 'Source-to-field mapping:\nAccess boundaries:\nUpdate / retention rules:', 'Record source lineage, transformations, and governance ownership.'),
    ],
    workflow: ['Map business concepts, sources, and governance boundaries', 'Review samples and existing definitions, then define entities and fields', 'Define quality rules and verify them on available samples', 'Deliver the dictionary, findings, and lineage notes'],
    checklist: ['Field names, types, and business definitions are explicit', 'Relationships and constraints are implementable', 'Quality conclusions state their sample scope and evidence', 'Sources, access boundaries, and unresolved definitions are traceable'],
    starterPrompts: [
      { label: 'Build the data dictionary', prompt: 'Build an entity and field dictionary from the business requirements and available sources. Identify definition conflicts, relationship constraints, and unresolved terms.' },
      { label: 'Check data quality', prompt: 'Define and run feasible checks against provided samples. Separate observed findings from unverified rules and give concrete governance recommendations.' },
    ],
    deliverableTitle: 'Data governance delivery', emptyTitle: 'Give every Agent the same data definitions', emptyDescription: 'Start with business requirements and real sources, then organize the dictionary, quality rules, and access boundaries.',
  }),
  template({
    id: 'users', title: 'User system', subtitle: 'Accounts, roles, and authorization lifecycle', tag: 'IDENTITY',
    persona: 'Own the account lifecycle, authentication, roles, and authorization policies. Define organization or workspace boundaries, resource ownership, and permission revocation. Supply an identity contract to business services without taking over unrelated APIs.',
    inputs: [
      field('brief', 'User and access requirements', true, 'User types:\nSign-up / sign-in methods:\nOrganization or workspace:\nKey access scenarios:', 'Describe who accesses which resources under which identity.'),
      field('roles', 'Roles and resources', false, 'Roles:\nResources:\nAllowed actions:\nResource ownership:', 'Define permissions by role, resource, and action rather than listing role names only.'),
      field('policies', 'Account policies', false, 'Invitation and joining:\nDisable and deletion:\nSession invalidation:\nPermission revocation:', 'Describe lifecycle changes for accounts and authorization.'),
      field('identityProviders', 'Identity providers', false, 'Existing account system:\nProtocol:\nCallback and environment constraints:', 'Describe existing identity services and integration conditions. Configure secrets separately.'),
    ],
    outputs: [
      field('identity', 'User-system contract', true, 'Account and identity model:\nAuthentication flow:\nSession and token rules:\nService integration:', 'Provide authentication and user-lifecycle conventions for frontend and backend services.'),
      field('permissions', 'Permission matrix', false, 'Role × resource × action:\nScope:\nDeny rules:', 'Deliver an authorization matrix that can drive implementation and tests.'),
      field('checks', 'Identity and access verification', false, 'Sign-in / sign-out:\nUnauthorized access and isolation:\nRevocation and invalidation:\nObserved result:', 'Record identity flows, cross-scope isolation, and revocation checks.'),
    ],
    workflow: ['Map user types, organization boundaries, and account lifecycle', 'Define authentication, session handling, and the permission matrix', 'Implement or integrate identity capabilities and verify isolation and revocation', 'Deliver the user-system contract, matrix, and verification records'],
    checklist: ['Account lifecycle and failure flows have explicit handling', 'Authorization covers roles, resources, and actions', 'Scope isolation and denial paths have verification evidence', 'Sign-out, disabling, and permission revocation have clear effect rules'],
    starterPrompts: [
      { label: 'Define the access model', prompt: 'Build a permission matrix, scope boundaries, and account lifecycle from the user requirements and role-resource list. Identify missing authorization decisions.' },
      { label: 'Implement identity flows', prompt: 'Implement or integrate the confirmed user-system contract. Verify sign-in, sign-out, isolation, and revocation, then deliver integration instructions.' },
    ],
    deliverableTitle: 'User-system delivery', emptyTitle: 'Define who can do what', emptyDescription: 'Define accounts, roles, and resource boundaries so other services can follow one identity contract.',
  }),
  template({
    id: 'materials', title: 'Content production', subtitle: 'Produce usable content for each audience and channel', tag: 'CONTENT',
    persona: 'Own copy, visual requirements, and asset delivery. Create content around the audience, channel, and brand goal. State sources and usage boundaries, and list only files that actually exist as generated assets.',
    inputs: [
      field('brief', 'Product and brand brief', true, 'Positioning:\nCore message:\nBrand voice:\nDesired action:', 'Define what the material communicates and what the audience should do.'),
      field('audience', 'Target audience', false, 'Audience traits:\nUse context:\nPriorities:\nLanguage:', 'Describe the audience context and knowledge level.'),
      field('channels', 'Channels and specifications', false, 'Publishing channels:\nSize / format:\nWord count:\nQuantity:', 'Tie each asset to a concrete channel and testable specification.'),
      field('references', 'Brand and asset references', false, 'Brand guide, existing asset, or example path / link', 'State what may be reused and what is only a style reference.', 'file'),
    ],
    outputs: [
      field('assets', 'Copy and asset inventory', true, 'Asset name:\nPurpose and channel:\nActual file / copy location:\nStatus:', 'List content and locations that frontend or publishing teams can use.'),
      field('copy', 'Ready-to-use copy', false, 'Headline:\nBody:\nCall to action:\nAlternatives:', 'Provide copy that matches the audience and channel.'),
      field('specifications', 'Production and usage notes', false, 'Format and size:\nVisual direction:\nSources:\nUsage restrictions:', 'Distinguish produced files, pending production instructions, and usage boundaries.'),
    ],
    workflow: ['Confirm the audience, channel specifications, and core product message', 'Develop copy and visual direction and check references', 'Produce authorized content and verify specifications', 'Deliver the actual inventory, copy, and usage notes'],
    checklist: ['Every item targets a defined audience and channel', 'Tone, message, and desired action are aligned', 'Files claimed as complete exist and have inspectable specifications', 'Sources, usage boundaries, and pending items are stated'],
    starterPrompts: [
      { label: 'Plan the content', prompt: 'Use the brand brief, audience, and channel specifications to list the content batch, key messages, and production order.' },
      { label: 'Produce and deliver', prompt: 'Create copy and assets within the authorized scope. Check channel specifications, list only actual outputs, and identify pending items.' },
    ],
    deliverableTitle: 'Content and asset delivery', emptyTitle: 'Create a content batch for a specific audience', emptyDescription: 'Define the brand message and channel specifications, then deliver copy and assets ready for use.',
  }),
  template({
    id: 'review', title: 'Delivery review', subtitle: 'Check actual delivery against explicit criteria', tag: 'REVIEW',
    persona: 'Independently review implementation and deliverables. Check actual evidence against explicit criteria and report reproducible issues and a review conclusion. Missing evidence cannot support a pass, and reviewed outputs must not be rewritten.',
    inputs: [
      field('delivery', 'Delivery under review', true, 'Scope:\nFiles or preview entry point:\nImplementation notes:\nKnown limitations:', 'Usually comes from a frontend or production node and must identify the actual delivery.'),
      field('api', 'API contract', false, 'Fields:\nStates and errors:\nIdentity and authorization:', 'Connect backend services to verify implementation against the API contract.'),
      field('criteria', 'Acceptance criteria', false, 'Scenarios:\nExpected behavior:\nPass conditions:\nOut of scope:', 'When criteria are missing, propose testable criteria and mark them pending approval.'),
      field('evidence', 'Verification evidence', false, 'Test report, screenshot, or action-log path / link', 'Cite real evidence with its source, time, and scope.', 'file'),
    ],
    outputs: [
      field('report', 'Review report', true, 'Conclusion:\nScope:\nVerified facts:\nUnverified and blocked work:', 'Distinguish pass, remediation, and insufficient evidence. An absent error log is not a pass.'),
      field('issues', 'Issues and rework', false, 'Issue:\nReproduction:\nExpected / actual:\nImpact:\nSuggested fix:', 'Give the responsible Agent enough detail to reproduce and fix each issue.'),
      field('verification', 'Verification record', false, 'Check:\nEvidence:\nObserved result:\nCoverage limits:', 'Record how each conclusion was reached and why any check was skipped.'),
    ],
    workflow: ['Confirm the scope, criteria, and accessible evidence', 'Check key flows, contract consistency, and error paths', 'Reproduce issues and state impact and rework guidance', 'Report evidence-backed conclusions and unverified scope'],
    checklist: ['Every conclusion maps to a specific criterion and evidence', 'Issues are reproducible and include expected and actual behavior', 'Missing evidence, skipped checks, and blockers are stated separately', 'Rework points to the responsible implementation node'],
    starterPrompts: [
      { label: 'Prepare the review', prompt: 'Build an acceptance checklist from the deliverable, API contract, and existing criteria. Identify missing entry points, evidence, and pass conditions.' },
      { label: 'Run the review', prompt: 'Check the current delivery item by item. Preserve actual evidence and report the conclusion, reproducible issues, and explicit unverified scope.' },
    ],
    deliverableTitle: 'Review result', emptyTitle: 'Define how completion will be proven', emptyDescription: 'Bring together the delivery, criteria, and evidence so the conclusion can be independently checked.',
  }),
];
