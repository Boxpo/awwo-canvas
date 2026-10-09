import { useId, useRef, useState } from 'react';
import { Bold, Eye, Heading2, Link2, List, Pencil, Plus, Trash2 } from 'lucide-react';
import { DeliverableMarkdown } from './DeliverableMarkdown';
import { validateContractFields, type ContractField, type ContractFieldType } from './nodeContracts';
import { useCanvasI18n, type CanvasTextKey } from './i18n';

const FIELD_TYPES: Array<{ value: ContractFieldType; label: CanvasTextKey }> = [
  { value: 'text', label: 'contract.text' },
  { value: 'markdown', label: 'contract.markdown' },
  { value: 'html', label: 'contract.html' },
  { value: 'number', label: 'contract.number' },
  { value: 'boolean', label: 'contract.boolean' },
  { value: 'file', label: 'contract.file' },
];

export interface ContractFieldsProps {
  fields: ContractField[];
  resolvedFields?: ContractField[];
  sources?: Record<string, string>;
  /** Fields whose resolved value is an upstream case recording (nodeConversation.ts). */
  recorded?: Record<string, true>;
  onChange: (fields: ContractField[]) => void;
  readOnly?: boolean;
  /** Task entry starts with values; contract customization remains available on demand. */
  valuesFirst?: boolean;
  label: string;
}

/** The serialized value always remains Markdown; preview never rewrites the source. A wired value is
 * another agent's delivery, so the preview renders it as inert as the delivery itself. */
function MarkdownValue({ field, name, readOnly, onChange, placeholder, describedBy }: {
  field: ContractField;
  name: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  describedBy?: string;
}) {
  const { locale, t } = useCanvasI18n();
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const format = (before: string, after = '') => {
    if (readOnly) return;
    const element = editor.current;
    const start = element?.selectionStart ?? field.value.length;
    const end = element?.selectionEnd ?? start;
    const selected = field.value.slice(start, end);
    onChange(field.value.slice(0, start) + before + selected + after + field.value.slice(end));
    queueMicrotask(() => {
      element?.focus();
      element?.setSelectionRange(start + before.length, end + before.length);
    });
  };
  return <div className="awwo-markdown">
    <div className="awwo-markdown-toolbar" role="toolbar" aria-label={t('contract.formatToolbar', { name })}>
      {[
        { label: 'contract.bold' as const, Icon: Bold, before: '**', after: '**' },
        { label: 'contract.heading' as const, Icon: Heading2, before: '## ', after: '' },
        { label: 'contract.list' as const, Icon: List, before: '- ', after: '' },
        { label: 'contract.link' as const, Icon: Link2, before: '[', after: '](https://)' },
      ].map(({ label, Icon, before, after }) => <button key={label} type="button" aria-label={locale === 'zh' ? `${name}${t(label)}` : `${name} ${t(label)}`} title={t(label)}
        disabled={readOnly || preview} onMouseDown={(e) => e.preventDefault()} onClick={() => format(before, after)}>
        <Icon size={15} aria-hidden="true" />
      </button>)}
      <button type="button" className="awwo-markdown-preview-toggle" aria-label={locale === 'zh' ? `${t(preview ? 'contract.edit' : 'contract.preview')}${name}` : `${t(preview ? 'contract.edit' : 'contract.preview')} ${name}`}
        aria-pressed={preview} onClick={() => setPreview(!preview)}>
        {preview ? <Pencil size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        {t(preview ? 'contract.edit' : 'contract.preview')}
      </button>
    </div>
    {preview ? <div className="awwo-markdown-preview" aria-label={t('contract.previewName', { name })} aria-describedby={describedBy}>
      {field.value ? <DeliverableMarkdown>{field.value}</DeliverableMarkdown> : <span className="awwo-field-hint">{t('contract.noContent')}</span>}
    </div> : <textarea ref={editor} className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={describedBy} value={field.value}
      disabled={readOnly} rows={4} onChange={(event) => onChange(event.target.value)} placeholder={placeholder ?? t('contract.placeholder')} />}
  </div>;
}

export function ContractFields({ fields, resolvedFields, sources, recorded, onChange, readOnly = false, valuesFirst = false, label }: ContractFieldsProps) {
  const { locale, t } = useCanvasI18n();
  const instanceId = useId();
  const [editingSchema, setEditingSchema] = useState(false);
  const showSchema = !valuesFirst || editingSchema;
  const nextField = useRef(0);
  const errors = validateContractFields(resolvedFields ?? fields);
  const patch = (id: string, update: Partial<ContractField>) => {
    if (!readOnly) onChange(fields.map((field) => field.id === id ? { ...field, ...update } : field));
  };
  const add = () => {
    if (readOnly) return;
    let id: string;
    do { id = `field-${instanceId.replace(/[^a-zA-Z0-9]/g, '')}-${++nextField.current}`; } while (fields.some((field) => field.id === id));
    onChange([...fields, { id, label: t('contract.defaultField', { count: fields.length + 1 }), type: 'text', required: false, value: '' }]);
  };
  return <section className="awwo-contract-fields" aria-label={t('contract.fields', { label })}>
    {valuesFirst && !readOnly && <button type="button" className="awwo-field-structure-toggle" aria-expanded={editingSchema} onClick={() => setEditingSchema(value => !value)}>{locale === 'zh' ? (editingSchema ? '完成结构编辑' : '编辑字段结构') : (editingSchema ? 'Done editing fields' : 'Edit field structure')}</button>}
    {fields.length === 0 ? <div className="awwo-contract-empty">{t('contract.empty', { label })}</div> : null}
    {fields.map((field, index) => {
      const name = field.label || t('contract.defaultField', { count: index + 1 });
      const source = sources?.[field.id];
      const displayed = resolvedFields?.find(item => item.id === field.id) ?? (source ? { ...field, value: '' } : field);
      const valueReadOnly = readOnly || Boolean(source);
      const helpId = field.help ? `${instanceId}-field-${index}-help` : undefined;
      return <div key={field.id} className="awwo-contract-field">
        {showSchema ? <><div className="awwo-field-header">
          <input className="awwo-field-name" aria-label={t('contract.fieldName', { count: index + 1 })} value={field.label} placeholder={t('contract.fieldNamePlaceholder')}
            disabled={readOnly} onChange={(event) => patch(field.id, { label: event.target.value })} />
          <select aria-label={t('contract.fieldType', { name })} value={field.type} disabled={readOnly}
            onChange={(event) => patch(field.id, { type: event.target.value as ContractFieldType })}>
            {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.label)}</option>)}
          </select>
          <button type="button" className="awwo-field-remove" aria-label={t('contract.removeField', { name })} disabled={readOnly}
            onClick={() => !readOnly && onChange(fields.filter((candidate) => candidate.id !== field.id))}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
        <label className="awwo-field-required"><input type="checkbox" aria-label={locale === 'zh' ? `${name}${t('contract.required')}` : `${name} ${t('contract.required')}`} checked={field.required}
          disabled={readOnly} onChange={(event) => patch(field.id, { required: event.target.checked })} />{t('contract.required')}</label></> : <div className="awwo-field-value-label"><strong>{name}</strong>{field.required && <span>{t('contract.required')}</span>}</div>}
        {helpId ? <p className="awwo-field-help" id={helpId}>{field.help}</p> : null}
        {source && <p className="awwo-field-hint">{t(resolvedFields ? (recorded?.[field.id] ? 'contract.sourceCase' : 'contract.sourceResolved') : 'contract.sourceWaiting', { source })}</p>}
        {field.type === 'markdown' ? <MarkdownValue field={displayed} name={name} readOnly={valueReadOnly} placeholder={field.placeholder} describedBy={helpId} onChange={(value) => patch(field.id, { value })} />
          : field.type === 'boolean' ? <select className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={helpId} value={displayed.value} disabled={valueReadOnly}
            onChange={(event) => patch(field.id, { value: event.target.value })}>
            <option value="">{field.placeholder ?? t('contract.choose')}</option><option value="true">{t('contract.yes')}</option><option value="false">{t('contract.no')}</option>
          </select>
          : <textarea className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={helpId} value={displayed.value} disabled={valueReadOnly}
            inputMode={field.type === 'number' ? 'decimal' : undefined} rows={field.type === 'html' ? 6 : field.type === 'text' ? 3 : 2}
            spellCheck={field.type === 'html' ? false : undefined}
            placeholder={field.placeholder ?? t(field.type === 'html' ? 'contract.htmlPlaceholder' : field.type === 'file' ? 'contract.filePlaceholder' : field.type === 'number' ? 'contract.numberPlaceholder' : 'contract.textPlaceholder')}
            onChange={(event) => patch(field.id, { value: event.target.value })} />}
        {field.type === 'file' ? <p className="awwo-field-hint">{t('contract.fileHint')}</p> : null}
      </div>;
    })}
    {errors.length > 0 ? <ul className="awwo-contract-errors" role="alert" aria-label={t('contract.validation', { label })}>
      {errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
    </ul> : null}
    {showSchema && <button type="button" className="awwo-field-add" disabled={readOnly} onClick={add}><Plus size={15} aria-hidden="true" />{t('contract.addField')}</button>}
  </section>;
}
