import { clsx } from "@axelor/ui";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { ScopeProvider } from "bunshi/react";
import { selectAtom, useAtomCallback } from "jotai/utils";
import {
  MutableRefObject,
  RefObject,
  SyntheticEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import uniq from "lodash/uniq";

import { Block, Box, CommandItemProps } from "@axelor/ui";
import { MaterialIcon } from "@axelor/ui/icons/material-icon";

import { alerts } from "@/components/alerts";
import { dialogs } from "@/components/dialogs";
import { useAsync } from "@/hooks/use-async";
import { useAsyncEffect } from "@/hooks/use-async-effect";
import { useContainerQuery } from "@/hooks/use-container-query";
import { parseExpression } from "@/hooks/use-parser/utils";
import { usePerms } from "@/hooks/use-perms";
import { useShortcuts, useTabShortcut } from "@/hooks/use-shortcut";
import { DataSource } from "@/services/client/data";
import { DataStore } from "@/services/client/data-store";
import { diff, extractDummy, isDummy } from "@/services/client/data-utils";
import { DataRecord } from "@/services/client/data.types";
import { i18n } from "@/services/client/i18n";
import { ViewData } from "@/services/client/meta";
import { FormView, Perms, Schema } from "@/services/client/meta.types";
import { ErrorReport } from "@/services/client/reject";
import { session } from "@/services/client/session";
import { focusAtom } from "@/utils/atoms";
import { Formatters } from "@/utils/format";
import { findViewItem } from "@/utils/schema";
import { isAdvancedSearchView } from "@/view-containers/advance-search/utils";
import { usePopupHandlerAtom } from "@/view-containers/view-popup/handler";
import { ViewToolBar } from "@/view-containers/view-toolbar";
import {
  useSelectViewState,
  useViewAction,
  useViewConfirmDirty,
  useViewDirtyAtom,
  useViewProps,
  useViewRoute,
  useViewSwitch,
  useViewTab,
  useViewTabRefresh,
} from "@/view-containers/views/scope";

import { useDMSPopup } from "../dms/builder/hooks";
import { ViewProps } from "../types";
import {
  FormAtom,
  Form as FormComponent,
  FormLayout,
  FormState,
  FormWidget,
  WidgetErrors,
  WidgetState,
  useFormHandlers,
} from "./builder";
import { createWidgetAtom } from "./builder/atoms";
import {
  FormEditableScope,
  FormReadyScope,
  FormValidityHandler,
  FormValidityScope,
  useAfterActions,
} from "./builder/scope";
import {
  getDefaultValues,
  processOriginal,
  processSaveValues,
} from "./builder/utils";
import { Collaboration } from "./widgets/collaboration";

import styles from "./form.module.scss";

export const fetchRecord = async (
  meta: ViewData<FormView>,
  dataStore: DataStore,
  id?: string | number,
  select?: Record<string, any>,
) => {
  if (id && +id > 0) {
    const fields = Object.keys(meta.fields ?? {});
    const related = meta.related;
    return dataStore.read(+id, { fields, related, select });
  }
  return getDefaultValues(meta.fields, meta.view.items);
};

export const showErrors = (errors: WidgetErrors[]) => {
  const titles = uniq(
    Object.values(errors).flatMap((e) =>
      Object.values(e)
        .filter(Boolean)
        .flatMap((v) => (typeof v === "object" ? Object.values(v) : v)),
    ),
  );
  titles.length &&
    alerts.error({
      message: (
        <ul>
          {titles.map((title, i) => (
            <li key={i}>{title}</li>
          ))}
        </ul>
      ),
    });
};

export const useGetErrors = () => {
  const store = useStore();
  return useCallback(
    (formState: FormState, fieldName?: string) => {
      const { states, statesByName = {} } = formState;
      const isHidden = function isHidden(s: WidgetState): boolean {
        return Boolean(
          s.attrs.hidden ||
            (s.name && statesByName[s.name]?.attrs?.hidden) ||
            (s.parent && isHidden(store.get(s.parent))),
        );
      };

      const serverErrors = Object.keys(statesByName)
        .filter((k) => statesByName[k].errors?.error)
        .filter((v) => Object.values(states).some((w) => w.name === v))
        .map((o) => Object.values(states).find((w) => w.name === o))
        .filter((s) => !isHidden(s!))
        .map((w) => {
          const error = i18n.get(`{0} is invalid`, w?.attrs?.title || w?.name);
          return { error } as WidgetErrors;
        });

      const errors = Object.values(states)
        .filter((s) => fieldName === undefined || s.name === fieldName)
        .filter((s) => !isHidden(s))
        .filter(
          (s) => Object.keys(s.errors ?? {}).length > 0 && s.valid !== true,
        )
        .map((s) => s.errors ?? {})
        .concat(serverErrors);
      return errors.length ? errors : null;
    },
    [store],
  );
};

export const useHandleFocus = (containerRef: RefObject<HTMLDivElement>) => {
  const handleFocus = useCallback(() => {
    const elem = containerRef.current;
    if (elem) {
      const selector = ["input", "select", "textarea"]
        .map(
          (name) =>
            `${name}[data-input]:not([readonly]), [data-input] ${name}:not([readonly]), ${name}[tabindex]:not([readonly])`,
        )
        .join(", ");
      const input = elem.querySelector(selector) as HTMLInputElement;
      focusAndSelectInput(input);
    }
  }, [containerRef]);
  return handleFocus;
};

export const focusAndSelectInput = (input?: null | HTMLInputElement) => {
  if (input) {
    input.focus();
    input.select();
  }
};

const timeSymbol = Symbol("$$time");
const defaultSymbol = Symbol("$$default");

export function Form(props: ViewProps<FormView>) {
  const { meta, dataStore } = props;

  const { id } = useViewRoute();
  const [viewProps = {}] = useViewProps();
  const { action } = useViewTab();
  const recordRef = useRef<DataRecord | null>(null);

  const { params } = action;
  const recordId = String(id || "");
  const readonly =
    !params?.forceEdit &&
    (params?.forceReadonly || (viewProps.readonly ?? Boolean(recordId)));

  const popupRecord = params?.["_popup-record"];

  const { state, data: record = {} } = useAsync(async () => {
    const record = recordRef.current;
    if (record) {
      recordRef.current = null;
      if (!recordId || String(record?.id) === recordId) {
        return { ...record };
      }
    }
    if (popupRecord) {
      if ((popupRecord?.id ?? 0) > 0) {
        if (popupRecord._fetched) return popupRecord;
        const res = await fetchRecord(meta, dataStore, popupRecord.id);
        return {
          _fetched: true,
          ...(popupRecord._dirty ? { ...res, ...popupRecord } : res),
        };
      } else {
        return popupRecord?.id == null
          ? {
              ...getDefaultValues(meta.fields, meta.view.items),
              ...popupRecord,
            }
          : popupRecord;
      }
    }
    return await fetchRecord(meta, dataStore, recordId);
  }, [popupRecord, recordId, meta, dataStore]);

  const [perms, setPerms] = useState(() => meta.perms);

  const dataSource = useMemo(
    () => meta.model && new DataSource(meta.model),
    [meta.model],
  );

  useAsyncEffect(async () => {
    if (!dataSource || params?.popup || !recordId) return;
    const recordPerms = await dataSource.perms(Number(recordId));
    setPerms((perms) => ({ ...perms, ...recordPerms }));
  }, [dataSource, params?.popup, recordId]);

  const isLoading = state !== "hasData";
  return (
    <FormContainer
      {...props}
      isLoading={isLoading}
      record={record}
      recordRef={recordRef}
      readonly={readonly}
      perms={perms}
    />
  );
}

const FormContainer = memo(function FormContainer({
  meta,
  dataStore,
  record,
  recordRef,
  searchAtom,
  isLoading,
  perms,
  ...props
}: ViewProps<FormView> & {
  record: DataRecord;
  recordRef: MutableRefObject<DataRecord | null>;
  readonly?: boolean;
  isLoading?: boolean;
  perms?: Perms;
}) {
  const { view: schema } = meta;
  const {
    onNew: onNewAction,
    onLoad: onLoadAction,
    onDelete: onDeleteAction,
    onSave: onSaveAction,
  } = schema;

  const defaultRecord = useRef({ [defaultSymbol]: true }).current;
  const {
    id: tabId,
    popup,
    popupOptions,
    action,
    state: tabAtom,
  } = useViewTab();
  const [viewProps, setViewProps] = useViewProps();
  const { formAtom, actionHandler, recordHandler, actionExecutor } =
    useFormHandlers(meta, defaultRecord, {
      context: action?.context,
    });

  const showConfirmDirty = useViewConfirmDirty();
  const { hasButton } = usePerms(meta.view, perms ?? meta.perms);
  const attachmentItem = useFormAttachment(formAtom);

  const readyAtom = useMemo(
    () =>
      focusAtom(
        formAtom,
        (state) => state.ready,
        (state, ready) => ({ ...state, ready }),
      ),
    [formAtom],
  );
  const setReady = useSetAtom(readyAtom);

  const [formDirty, setFormDirty] = useAtom(
    useMemo(
      () =>
        focusAtom(
          formAtom,
          (state) => state.dirty,
          (state, dirty) => ({ ...state, dirty }),
        ),
      [formAtom],
    ),
  );

  const archived = useAtomValue(
    useMemo(
      () => selectAtom(formAtom, (form) => form.record?.archived),
      [formAtom],
    ),
  );

  const widgetAtom = useMemo(
    () => createWidgetAtom({ schema, formAtom }),
    [formAtom, schema],
  );

  const { attrs } = useAtomValue(widgetAtom);
  const setAttrs = useSetAtom(widgetAtom);

  const [readonlyExclusive, setReadonlyExclusive] = useState(false);

  useEffect(() => {
    const readonlyIf = schema.readonlyIf;
    if (!readonlyIf) return;
    return recordHandler.subscribe((record) => {
      const value = Boolean(parseExpression(readonlyIf)(record));
      setReadonlyExclusive((prev) => value);
    });
  }, [recordHandler, schema.readonlyIf]);

  const canNew = hasButton("new");
  const canSaveNew = canNew && !record.id;
  const hasEdit = hasButton("edit") || canSaveNew;
  const hasSave = hasButton("save") || canSaveNew;

  const readonly = useMemo(() => {
    const readonly = readonlyExclusive || (attrs.readonly ?? props.readonly);
    return !readonly && !hasEdit ? true : readonly;
  }, [readonlyExclusive, attrs.readonly, props.readonly, hasEdit]);

  const prevType = useSelectViewState(
    useCallback((state) => state.prevType, []),
  );

  const copyRecordRef = useRef(false);
  const widgetsRef = useRef(new Set<FormValidityHandler>());
  const editableWidgetsRef = useRef(new Set<() => void>());
  const switchTo = useViewSwitch();

  const dirtyAtom = useViewDirtyAtom();
  const [isDirty, setDirty] = useAtom(dirtyAtom);

  const handleAddWidgetValidator = useCallback((fn: FormValidityHandler) => {
    widgetsRef.current.add(fn);
    return () => widgetsRef.current.delete(fn);
  }, []);

  const handleAddEditableWidget = useCallback((fn: () => void) => {
    editableWidgetsRef.current.add(fn);
    return () => editableWidgetsRef.current.delete(fn);
  }, []);

  const handleCommitEditableWidgets = useCallback(() => {
    return Promise.all(
      Array.from(editableWidgetsRef.current).map((fn) => fn()),
    );
  }, []);

  const doRead = useCallback(
    async (id: number | string, select?: Record<string, any>) => {
      return await fetchRecord(meta, dataStore, id, select);
    },
    [dataStore, meta],
  );

  const executeLate = useAfterActions(
    useCallback(
      async (action: string) =>
        actionExecutor.execute(action, { enqueue: true }),
      [actionExecutor],
    ),
  );

  const doEdit = useAtomCallback(
    useCallback(
      async (
        get,
        set,
        record: DataRecord | null,
        options?: {
          readonly?: boolean;
          dirty?: boolean;
          isNew?: boolean;
          keepStates?: boolean;
          callAction?: boolean; // to call onLoad/onNew action immediately
          callOnNew?: boolean; // to call onNew action or not
          callOnLoad?: boolean; // to call onLoad action or not
        },
      ) => {
        const id = String(record?.id ?? "");
        const prev = get(formAtom);
        const {
          isNew,
          dirty = false,
          callAction = true,
          callOnNew = true,
          callOnLoad = true,
          keepStates,
          ...props
        } = { readonly, ...options };

        const isNewAction = !record;
        const action = isNewAction
          ? callOnNew && onNewAction
          : callOnLoad && onLoadAction;
        const isNewFromUnsaved = isNew && record === null && !prev.record.id;

        record = record ?? {};
        record =
          record.id && record.id > 0
            ? record
            : {
                ...getDefaultValues(prev.meta.fields, prev.meta.view.items),
                ...record,
              };

        // this is required to trigger expression re-evaluation
        record = { ...record, [timeSymbol]: Date.now() };

        if (isNew) {
          recordRef.current = record;
        }

        if (!keepStates) {
          const event = new CustomEvent("form:reset-states", { detail: tabId });
          document.dispatchEvent(event);
        }

        const tabState = get(tabAtom);
        const tabRoute = tabState.routes?.form;
        const tabProps = tabState.props?.form;
        if (
          String(tabRoute?.id) !== String(id) ||
          tabProps?.readonly != props.readonly
        ) {
          switchTo("form", { route: { id }, props });
        }

        set(formAtom, {
          ...prev,
          dirty,
          ...(keepStates
            ? (() => {
                // reset dummy fields state
                // only keep real fields state
                const fieldNames = Object.keys(meta.fields ?? {});
                return {
                  statesByName: Object.keys(prev.statesByName)
                    .filter((key) => !isDummy(key, fieldNames))
                    .reduce(
                      (state, key) => ({
                        ...state,
                        [key]: prev.statesByName[key],
                      }),
                      {},
                    ),
                };
              })()
            : { states: {}, statesByName: {} }),
          record,
          original: { ...record },
        });

        if (action && (!isNew || isNewFromUnsaved)) {
          if (callAction) {
            // execute action
            await actionExecutor.execute(action, { enqueue: false });

            // fix undefined values set by action
            let { record: current, original = {} } = get(formAtom);
            let changed = false;
            let res = Object.entries(current).reduce(
              (acc, [key, value]) => {
                if (value === undefined && original[key] === null) {
                  changed = true;
                  acc[key] = null;
                }
                return acc;
              },
              { ...current },
            );

            if (changed) {
              set(formAtom, { ...prev, record: res });
            }
          } else {
            executeLate(action);
          }

          const isDirty = isNewAction ? false : !!get(formAtom).dirty;

          setFormDirty(isNewAction ? false : get(formAtom).dirty);
          setDirty(isDirty);
          setReady(true);
        }

        if (!isNew) {
          const event = new CustomEvent("form:refresh", { detail: tabId });
          document.dispatchEvent(event);
        }
      },
      [
        meta,
        formAtom,
        readonly,
        onNewAction,
        onLoadAction,
        tabAtom,
        recordRef,
        tabId,
        switchTo,
        setFormDirty,
        setDirty,
        setReady,
        actionExecutor,
        executeLate,
      ],
    ),
  );
  const doNew = useCallback(
    async ({ confirmDirty = true }: { confirmDirty?: boolean } = {}) => {
      if (confirmDirty) {
        showConfirmDirty(
          async () => isDirty,
          async () => {
            doEdit(null, { readonly: false, isNew: true });
          },
        );
      } else {
        doEdit(null, { readonly: false, isNew: true });
      }
    },
    [doEdit, isDirty, showConfirmDirty],
  );

  const onNew = useCallback(async () => doNew(), [doNew]);

  const onEdit = useCallback(async () => {
    setAttrs((prev) => ({
      ...prev,
      attrs: { ...prev.attrs, readonly: false },
    }));
  }, [setAttrs]);

  const onBack = useAtomCallback(
    useCallback(
      async (get) => {
        const record = get(formAtom).record;
        const recordId = record.id || -1;
        if (readonly || recordId < 0) {
          if (prevType) {
            switchTo(prevType);
          }
        } else {
          setAttrs((prev) => ({
            ...prev,
            attrs: { ...prev.attrs, readonly: true },
          }));
        }
      },
      [formAtom, prevType, readonly, setAttrs, switchTo],
    ),
  );

  const getFieldErrors = useGetErrors();
  const getWidgetErrors = useCallback(() => {
    return Array.from(widgetsRef.current).some((checkWidgetInvalid) =>
      checkWidgetInvalid(),
    );
  }, []);

  const getErrors = useAtomCallback(
    useCallback(
      (get) => {
        const formState = get(formAtom);
        const errors = getFieldErrors(formState);
        if (errors || getWidgetErrors()) {
          return errors || [];
        }
        return;
      },
      [formAtom, getFieldErrors, getWidgetErrors],
    ),
  );

  const handleOnSaveErrors = useAtomCallback(
    useCallback(
      async function onError(
        get,
        set,
        error: ErrorReport,
      ): Promise<DataRecord> {
        const { entityId, entityName, title, message } = error;
        if (entityId && entityName) {
          const confirmed = await dialogs.confirm({
            title: title!,
            content: (
              <div>
                <p>{message}</p>
                <p>{i18n.get("Would you like to reload the record?")}</p>
              </div>
            ),
          });

          if (confirmed) {
            const {
              record: { id },
            } = get(formAtom);
            if ((id ?? 0) > 0) {
              return { id };
            }
          }
          throw 500;
        }
        throw error;
      },
      [formAtom],
    ),
  );

  /**
   * Handle the form save. This includes 3 parts:
   * <ul>
   * <li>firstly, check the record errors. On errors, the process is interrupted.</li>
   * <li>secondly, perform the save request.</li>
   * <li>thirdly, read the record. This makes sure the record is up-to-date.</li>
   * </ul>
   *
   * This also makes sure to restore the dummy fields after the record is saved.
   *
   * Options that can be used:
   *
   * @param {boolean} [options.shouldSave] - (default: true) whether it should perform record save request
   * @param {boolean} [options.callOnSave] - (default: true) whether it should call `onSave` actions
   * @param {boolean} [options.callOnRead] - (default: true) whether it should read the record once save request is done
   * @param {boolean} [options.callOnLoad] - (default: true) whether it should call `onLoad` actions (has effect if `callOnRead` is `true`)
   * @param {boolean} [options.handleErrors] - (default: false) whether it should handle errors upon save request
   *
   * @return {DataRecord} the record
   */
  const doSave = useAtomCallback(
    useCallback(
      async (
        get,
        set,
        options?: {
          shouldSave?: boolean;
          callOnSave?: boolean;
          callOnRead?: boolean;
          callOnLoad?: boolean;
          handleErrors?: boolean;
        },
      ) => {
        const {
          shouldSave = true,
          callOnSave = true,
          callOnRead = true,
          callOnLoad = options?.callOnSave !== false,
          handleErrors = false,
        } = options ?? {};
        const formState = get(formAtom);
        const errors = getErrors();
        if (errors) {
          showErrors(errors);
          return Promise.reject();
        }

        const { record } = formState;
        const fieldNames = Object.keys(meta.fields ?? {});
        const dummy = extractDummy(record, fieldNames);
        const dummyVals = Object.entries(dummy).reduce((acc, [k, v]) => {
          return k.startsWith("$")
            ? { ...acc, [k.substring(1)]: v }
            : { ...acc, [k]: v };
        }, {});

        if (onSaveAction && callOnSave) {
          await actionExecutor.execute(onSaveAction);
        }

        if (!shouldSave) return record;

        const { record: rec, original = {}, select, model } = get(formAtom); // record may have changed by actions
        const vals = diff(rec, original);
        const opts = handleErrors ? { onError: handleOnSaveErrors } : undefined;

        let res = await dataStore.save(
          {
            ...processSaveValues(
              {
                ...dummyVals,
                ...vals,
              },
              formState.meta,
            ),
            _original: processOriginal(original, meta.fields ?? {}), // pass original values to check for concurrent updates
          },
          {
            ...opts,
            fields: Object.keys(meta.fields ?? {}),
            related: meta.related,
            select,
          },
        );

        if (callOnRead) {
          const savedResult = res;
          const restoreDummyValues = Object.keys(dummy).reduce(
            (values, key) => {
              const viewItem = findViewItem(meta, key);
              return viewItem?.resetState === true
                ? values
                : { ...values, [key]: dummy[key] };
            },
            {},
          );
          res = res.id ? await doRead(res.id, select) : res;
          res = res.id ? fillRecordWithCid(savedResult, res) : res;
          res = {
            ...restoreDummyValues,
            ...res,
          }; // restore dummy values
          doEdit(res, {
            callAction: false,
            callOnLoad,
            readonly,
            isNew: vals.id !== res.id,
            keepStates: true,
          });
        }

        return res;
      },
      [
        meta,
        formAtom,
        getErrors,
        onSaveAction,
        handleOnSaveErrors,
        dataStore,
        actionExecutor,
        doRead,
        doEdit,
        readonly,
      ],
    ),
  );

  const onSave: typeof doSave = useAfterActions(
    useCallback(
      async (options) => {
        // XXX: Need to find a way to coordinate top save and grid commit.
        actionExecutor.waitFor(300);
        await handleCommitEditableWidgets();
        return doSave(options);
      },
      [actionExecutor, doSave, handleCommitEditableWidgets],
    ),
  );

  const handleOnSave = useCallback(async () => {
    try {
      await onSave({
        handleErrors: true,
      });
    } catch (error) {
      // default handler will show the errors
    }
  }, [onSave]);

  const reload = useAtomCallback(
    useCallback(
      async (
        get,
        set,
        options?: { callAction?: boolean; confirmDirty?: boolean },
      ) => {
        const { record, select } = get(formAtom);
        const id = record.id ?? 0;
        if (id <= 0) {
          return doNew(options);
        }
        const rec = await doRead(id, select);
        await doEdit(rec, { callAction: false, ...options });
      },
      [doEdit, doNew, doRead, formAtom],
    ),
  );

  const onTabRefresh = useCallback(
    async (options?: { forceReload?: boolean }) => {
      if (options?.forceReload) {
        return reload();
      }
      await showConfirmDirty(
        async () => isDirty,
        async () => reload({ confirmDirty: false }),
      );
    },
    [isDirty, reload, showConfirmDirty],
  );

  const onRefresh = useCallback(() => onTabRefresh(), [onTabRefresh]);

  const actionReload = useCallback(
    () => reload({ callAction: false }),
    [reload],
  );

  actionHandler.setRefreshHandler(actionReload);
  actionHandler.setSaveHandler(
    useAtomCallback(
      useCallback(
        async (get, set, record?: DataRecord) => {
          if (record) {
            await dataStore.save(record);
            return;
          }
          const { record: rec, dirty: formDirty } = get(formAtom);
          const dirty = get(dirtyAtom) || formDirty;
          const isNew = (rec.id || 0) <= 0;
          await doSave({
            callOnSave: false,
            shouldSave: dirty || isNew,
          });
        },
        [formAtom, dirtyAtom, dataStore, doSave],
      ),
    ),
  );
  actionHandler.setValidateHandler(
    useAtomCallback(
      useCallback(
        async (get) => {
          const { record } = get(formAtom);
          const { id = 0, version = 0 } = record;
          if (id === null || version === null || id <= 0) return;
          if (await dataStore.verify({ id, version })) return;
          throw new Error(
            i18n.get(
              "The record has been updated or deleted by another action.",
            ),
          );
        },
        [dataStore, formAtom],
      ),
    ),
  );

  const onDelete = useAtomCallback(
    useCallback(
      async (get) => {
        const record = get(formAtom).record;
        const id = record.id || 0;
        const version = record.version || 0;
        if (id > 0 && version >= 0) {
          const confirmed = await dialogs.confirm({
            content: i18n.get(
              "Do you really want to delete the selected record?",
            ),
            yesTitle: i18n.get("Delete"),
          });
          if (confirmed) {
            if (onDeleteAction) {
              await actionExecutor.execute(onDeleteAction, {
                context: record,
              });
            }
            await dataStore.delete({ id, version });
            if (prevType) {
              switchTo(prevType);
            } else {
              onNew();
            }
          }
        }
      },
      [
        dataStore,
        formAtom,
        onDeleteAction,
        onNew,
        prevType,
        switchTo,
        actionExecutor,
      ],
    ),
  );

  const onCopy = useCallback(async () => {
    if (record.id) {
      const rec = await dataStore.copy(record.id);
      rec && (copyRecordRef.current = true);
      doEdit(rec, { dirty: true, readonly: false, isNew: true });
    }
  }, [dataStore, doEdit, record.id]);

  const openProcess = useCallback(async () => {
    if (record.id && record.$processInstanceId) {
      await actionExecutor.execute("wkf-instance-view-from-record");
    }
  }, [actionExecutor, record.id, record.$processInstanceId]);

  const onArchive = useAtomCallback(
    useCallback(
      async (get, set, archived: boolean = true) => {
        if (record.id) {
          const state = get(formAtom);
          const confirmed = await dialogs.confirm({
            content: archived
              ? i18n.get("Do you really want to archive the selected record?")
              : i18n.get(
                  "Do you really want to unarchive the selected record?",
                ),
          });
          if (confirmed) {
            const id = record.id!;
            const version = state.record.version!;
            const res = await dataStore.save({ id, version, archived });
            if (!res) return;
            if (prevType) {
              switchTo(prevType);
            } else {
              onRefresh();
            }
          }
        }
      },
      [dataStore, record.id, prevType, formAtom, switchTo, onRefresh],
    ),
  );

  const onAudit = useAtomCallback(
    useCallback(
      async (get, set) => {
        const rec = get(formAtom).record;
        const id = rec.id;
        if (id && id > 0) {
          const res = await dataStore.read(id, {
            fields: ["createdBy", "createdOn", "updatedBy", "updatedOn"],
          });
          const name = session.info?.user?.nameField ?? "name";
          dialogs.info({
            content: (
              <dl className={styles.dlist}>
                <dt>{i18n.get("Created By")}</dt>
                <dd>{(res.createdBy || {})[name]}</dd>
                <dt>{i18n.get("Created On")}</dt>
                <dd>{Formatters.datetime(res.createdOn)}</dd>
                <dt>{i18n.get("Updated By")}</dt>
                <dd>{(res.updatedBy || {})[name]}</dd>
                <dt>{i18n.get("Updated On")}</dt>
                <dd>{Formatters.datetime(res.updatedOn)}</dd>
              </dl>
            ),
          });
        }
      },
      [dataStore, formAtom],
    ),
  );

  const pagination = usePagination(
    viewProps?.dataStore ?? dataStore,
    record,
    readonly,
  );
  const popupHandlerAtom = usePopupHandlerAtom();
  const setPopupHandlers = useSetAtom(popupHandlerAtom);

  const showToolbar = popupOptions?.showToolbar !== false;

  const getState = useAtomCallback(
    useCallback((get) => get(formAtom), [formAtom]),
  );

  const doOnLoad = useAtomCallback(
    useCallback(
      async (get, set) => {
        if (isLoading) return;
        let rec = get(formAtom).record;
        if ((rec as any)[defaultSymbol] || rec.id !== record.id) {
          const state = get(formAtom);
          set(formAtom, {
            ...state,
            states: {},
            statesByName: {},
            record,
            dirty: false,
            original: { ...record },
          });
          rec = record;
        }
        const recId = rec.id ?? 0;
        const isNew = !(recId > 0 || record._dirty);
        const action = isNew ? onNewAction : onLoadAction;

        if (copyRecordRef.current) {
          copyRecordRef.current = false;
          return;
        }
        if (action) {
          await actionExecutor.execute(action);
          // skip form dirty for onNew
          isNew && setFormDirty(false);
        }
        setReady(true);
      },
      [
        actionExecutor,
        formAtom,
        isLoading,
        onLoadAction,
        onNewAction,
        record,
        setFormDirty,
        setReady,
      ],
    ),
  );

  useAsyncEffect(doOnLoad, [doOnLoad]);

  useEffect(() => {
    formDirty !== undefined && setDirty(formDirty);
  }, [formDirty, setDirty]);

  useEffect(() => {
    setViewProps((props) => ({ ...props, readonly }));
  }, [readonly, setViewProps]);

  const tab = useViewTab();
  const currentViewType = useSelectViewState(useCallback((x) => x.type, []));

  const canEdit = readonly && !readonlyExclusive && hasEdit;
  const canSave = !readonly && hasSave;
  const canDelete = hasButton("delete") && record.id;
  const canCopy = !isDirty && canNew && hasButton("copy") && record.id;
  const canArchive = hasButton("archive") && record.id;
  const canAudit = hasButton("log") && record.id;
  const canAttach = hasButton("attach") && record.id;
  const canOpenProcess =
    session.info?.features?.studio && record.id && record.$processInstanceId;

  const handleSave = useCallback(
    async (e?: SyntheticEvent) => {
      const onSaveClick = e?.type === "click";
      if (!onSaveClick) {
        const input = document.activeElement as HTMLInputElement;
        const elem = containerRef.current;

        if (input && elem?.contains(input)) {
          input.blur?.();
          input.focus?.();
        }

        // fake click to trigger outside click logic of any editable row
        elem?.click?.();
      }
      await actionExecutor.waitFor();
      actionExecutor.wait().then(handleOnSave);
    },
    [actionExecutor, handleOnSave],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  const handleFocus = useHandleFocus(containerRef);

  // register shortcuts
  useShortcuts({
    viewType: schema.type,
    onNew: canNew ? onNew : undefined,
    onEdit: canEdit ? onEdit : undefined,
    onSave: canSave ? handleSave : undefined,
    onCopy: canCopy ? onCopy : undefined,
    onDelete: canDelete ? onDelete : undefined,
    onRefresh: onRefresh,
    onFocus: handleFocus,
  });

  useEffect(() => {
    if (popup) {
      setPopupHandlers({
        getState,
        getErrors,
        onSave,
        onEdit: doEdit,
        onRead: doRead,
        actionHandler,
        actionExecutor,
        readyAtom,
        dirtyAtom,
        commitForm: handleCommitEditableWidgets,
        attachmentItem: canAttach ? attachmentItem : null,
      });
    }
  }, [
    getState,
    getErrors,
    doEdit,
    doRead,
    onSave,
    popup,
    setPopupHandlers,
    actionHandler,
    actionExecutor,
    readyAtom,
    dirtyAtom,
    handleCommitEditableWidgets,
    attachmentItem,
    canAttach,
  ]);

  const { views = [] } = useViewAction();

  const searchViewType = useMemo(
    () =>
      prevType != null && isAdvancedSearchView(prevType)
        ? prevType
        : views.find((view) => isAdvancedSearchView(view.type))?.type,
    [prevType, views],
  );

  const setSearchFocusTabId = useSetAtom(
    useMemo(
      () =>
        focusAtom(
          searchAtom!,
          (state) => state.focusTabId,
          (state, focusTabId) => ({ ...state, focusTabId }),
        ),
      [searchAtom],
    ),
  );

  useTabShortcut({
    key: "f",
    altKey: true,
    canHandle: useCallback(
      () => currentViewType === schema.type && searchViewType != null,
      [searchViewType, currentViewType, schema.type],
    ),
    action: useCallback(() => {
      void (async () => {
        await showConfirmDirty(
          async () => isDirty,
          async () => {
            setSearchFocusTabId(tab.id);
            switchTo(searchViewType!);
          },
        );
      })();
    }, [
      isDirty,
      searchViewType,
      setSearchFocusTabId,
      tab.id,
      switchTo,
      showConfirmDirty,
    ]),
  });

  // register tab:refresh
  useViewTabRefresh("form", onTabRefresh);

  // check version
  useCheckVersion(formAtom, dataStore, onRefresh);

  return (
    <div className={styles.formViewContainer}>
      {showToolbar && (
        <ViewToolBar
          meta={meta}
          formAtom={formAtom}
          actionExecutor={actionExecutor}
          recordHandler={recordHandler}
          actions={[
            {
              key: "new",
              text: i18n.get("New"),
              hidden: !canNew,
              iconProps: {
                icon: "add",
              },
              onClick: onNew,
            },
            {
              key: "edit",
              text: i18n.get("Edit"),
              hidden: !canEdit,
              iconProps: {
                icon: "edit",
              },
              onClick: onEdit,
            },
            {
              key: "save",
              text: i18n.get("Save"),
              iconProps: {
                icon: "save",
              },
              onClick: handleSave,
              hidden: !canSave,
            },
            {
              key: "cancel",
              text: i18n.get("Cancel"),
              iconProps: {
                icon: "refresh",
              },
              onClick: onRefresh,
              hidden: !isDirty,
            },
            {
              key: "back",
              text: i18n.get("Back"),
              iconProps: {
                icon: "arrow_back",
              },
              onClick: onBack,
              hidden: isDirty,
            },
            {
              ...attachmentItem,
              hidden: !canAttach,
            },
            {
              key: "more",
              iconOnly: true,
              iconProps: {
                icon: "arrow_drop_down",
              },
              items: [
                {
                  key: "refresh",
                  text: i18n.get("Refresh"),
                  onClick: onRefresh,
                },
                {
                  key: "delete",
                  text: i18n.get("Delete"),
                  disabled: !canDelete,
                  iconProps: {
                    icon: "delete",
                  },
                  onClick: onDelete,
                },
                {
                  key: "copy",
                  text: i18n.get("Duplicate"),
                  onClick: onCopy,
                  disabled: !canCopy,
                },
                {
                  key: "s1",
                  divider: true,
                  hidden: !canOpenProcess,
                },
                {
                  key: "openProcess",
                  text: i18n.get("Display process"),
                  onClick: openProcess,
                  hidden: !canOpenProcess,
                },
                {
                  key: "s2",
                  divider: true,
                  hidden: !canArchive || isDirty,
                },
                {
                  key: "archive",
                  text: archived ? i18n.get("Unarchive") : i18n.get("Archive"),
                  onClick: () => onArchive(!archived),
                  hidden: !canArchive || isDirty,
                },
                {
                  key: "s3",
                  divider: true,
                  hidden: !canAudit,
                },
                {
                  key: "audit",
                  text: i18n.get("Last modified..."),
                  onClick: onAudit,
                  hidden: !canAudit,
                },
              ],
            },
          ]}
          pagination={pagination}
        >
          <Block className={styles.collaboration}>
            <Collaboration formAtom={formAtom} />
          </Block>
        </ViewToolBar>
      )}
      <div className={styles.formViewScroller} ref={containerRef}>
        <ScopeProvider scope={FormReadyScope} value={readyAtom}>
          <ScopeProvider
            scope={FormEditableScope}
            value={{
              add: handleAddEditableWidget,
              commit: handleCommitEditableWidgets,
            }}
          >
            <ScopeProvider
              scope={FormValidityScope}
              value={{
                add: handleAddWidgetValidator,
              }}
            >
              <FormComponent
                className={styles.formView}
                readonly={readonly}
                schema={meta.view}
                fields={meta.fields!}
                formAtom={formAtom}
                recordHandler={recordHandler}
                actionHandler={actionHandler}
                actionExecutor={actionExecutor}
                layout={Layout}
                widgetAtom={widgetAtom}
              />
            </ScopeProvider>
          </ScopeProvider>
        </ScopeProvider>
      </div>
    </div>
  );
});

function usePagination(
  dataStore: DataStore,
  record: DataRecord,
  readonly?: boolean,
) {
  const { offset = 0, limit = 0, totalCount = 0 } = dataStore.page;
  const index = dataStore.records.findIndex((x) => x.id === record.id);

  const switchTo = useViewSwitch();

  const onPrev = useCallback(async () => {
    let prev = dataStore.records[index - 1];
    if (prev === undefined) {
      const { records = [] } = await dataStore.search({
        offset: offset - limit,
      });
      prev = records[records.length - 1];
    }
    const id = String(prev.id);
    const props = { readonly };
    switchTo("form", { route: { id }, props });
  }, [dataStore, index, limit, offset, readonly, switchTo]);

  const onNext = useCallback(async () => {
    let next = dataStore.records[index + 1];
    if (next === undefined) {
      const { records = [] } = await dataStore.search({
        offset: offset + limit,
      });
      next = records[0];
    }
    const id = String(next.id);
    const props = { readonly };
    switchTo("form", { route: { id }, props });
  }, [dataStore, index, limit, offset, readonly, switchTo]);

  const canPrev = index > -1 && offset + index > 0;
  const canNext = index > -1 && offset + index < totalCount - 1;

  const text =
    index > -1 ? i18n.get("{0} of {1}", offset + index + 1, totalCount) : "";

  return {
    canPrev,
    canNext,
    onPrev,
    onNext,
    text,
  };
}

function useFormWidth(
  schema: Schema,
  hasSide: boolean,
  isPopup: boolean = false,
) {
  const { width, minWidth, maxWidth } = schema;

  const className = useMemo(
    () => styles[width] ?? (hasSide ? undefined : styles.mid),
    [hasSide, width],
  );

  const style: React.CSSProperties = useMemo(() => {
    if (width === "*") return { maxWidth: "unset" };
    if (className) return { minWidth, maxWidth };
    return { width, minWidth, maxWidth };
  }, [className, maxWidth, minWidth, width]);

  const result = useMemo(
    () => (isPopup ? {} : { className, style }),
    [className, isPopup, style],
  );

  return result;
}

export const Layout: FormLayout = ({
  schema,
  formAtom,
  parentAtom,
  className,
  readonly,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const isSmall = useContainerQuery(ref, "width < 768px");

  const { main, side, small } = useMemo(() => {
    const items = schema.items ?? [];
    const head = items.filter((x) => x.widget === "wkf-status");
    const side = items.filter((x) => x.sidebar);
    const mail = items.filter(
      (x) => x.type === "panel-mail" && !side.includes(x),
    );
    const rest = items.filter(
      (x) => !head.includes(x) && !side.includes(x) && !mail.includes(x),
    );

    const sideTop = side.slice(0, 1);
    const sideAll = side.slice(1);

    const small = [...head, ...sideTop, ...rest, ...sideAll, ...mail];
    const main = [...head, ...rest, ...mail];

    return {
      main,
      side,
      small,
    };
  }, [schema]);

  const mainItems = isSmall ? small : main;
  const sideItems = isSmall ? [] : side;

  const { popup } = useViewTab();
  const { style, className: clsName } = useFormWidth(
    schema,
    side.length > 0,
    popup,
  );

  return (
    <div
      className={clsx(className, clsName, styles.formLayout, {
        [styles.small]: isSmall,
      })}
      style={style}
      ref={ref}
    >
      <div className={styles.main}>
        {mainItems.map((item) => (
          <FormWidget
            key={item.uid}
            schema={item}
            formAtom={formAtom}
            parentAtom={parentAtom}
            readonly={readonly}
          />
        ))}
      </div>
      {sideItems.length > 0 && (
        <div className={styles.side}>
          {side.map((item) => (
            <FormWidget
              key={item.uid}
              schema={item}
              formAtom={formAtom}
              parentAtom={parentAtom}
              readonly={readonly}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export function useFormAttachment(formAtom: FormAtom) {
  const showDMSPopup = useDMSPopup();
  const [$attachments, setAttachmentCount] = useAtom(
    useMemo(
      () =>
        focusAtom(
          formAtom,
          (state) => state.record.$attachments ?? 0,
          (state, $attachments) => ({
            ...state,
            record: { ...state.record, $attachments },
          }),
        ),
      [formAtom],
    ),
  );

  const handleClick = useAtomCallback(
    useCallback(
      (get) => {
        const { record, model, fields } = get(formAtom);
        return showDMSPopup({
          record,
          model,
          fields,
          onCountChanged: (totalCount) => setAttachmentCount(totalCount),
        });
      },
      [formAtom, showDMSPopup, setAttachmentCount],
    ),
  );

  return {
    key: "attachment",
    text: i18n.get("Attachment"),
    icon: (props: any) => (
      <Box as="span" d="flex" position="relative">
        <MaterialIcon icon="attach_file" {...props} />
        {$attachments ? (
          <Box d="flex" as="small" alignItems="flex-end">
            {$attachments}
          </Box>
        ) : null}
      </Box>
    ),
    iconProps: {
      icon: "attach_file",
    },
    onClick: handleClick,
  } as CommandItemProps;
}

const compact = (rec: any) => {
  const res: DataRecord = {
    id: rec.id,
    version: rec.version,
  };
  if (res.version === undefined) {
    res.version = rec.$version;
  }
  Object.entries(rec).forEach(([k, v]) => {
    if (!v) return;
    if ((v as any).id > 0) res[k] = compact(v);
    if (Array.isArray(v)) res[k] = v.map(compact);
  });
  return res;
};

function fillRecordWithCid(savedRecord: DataRecord, fetchedRecord: DataRecord) {
  function fillCid(prev: any, curr: any): any {
    if (Array.isArray(curr)) {
      return curr.map((v: DataRecord) =>
        fillCid(
          prev?.find?.((p: DataRecord) => p.id === v.id),
          v,
        ),
      );
    }
    if (curr && prev && typeof curr === "object") {
      return {
        ...Object.keys(curr).reduce(
          (rec, k) => ({ ...rec, [k]: fillCid(prev[k], curr[k]) }),
          {} as DataRecord,
        ),
        ...(prev.cid && {
          cid: prev.cid,
        }),
      };
    }
    return curr;
  }
  return fillCid(savedRecord, fetchedRecord);
}

function useCheckVersion(
  formAtom: FormAtom,
  dataStore: DataStore,
  onConfirm: () => void,
) {
  const tab = useViewTab();
  const info = session.info;

  const check = useAtomCallback(
    useCallback(
      async (get) => {
        const { context = {} } = tab.action;
        const { record } = get(formAtom);
        const { __check_version = info?.view?.form?.checkVersion } = context;
        if (__check_version && record?.id && record.id > 0) {
          const res = await dataStore.verify(compact(record));
          if (res) return;
          const confirmed = await dialogs.confirm({
            content:
              i18n.get(
                "The record has been updated or deleted by another action.",
              ) +
              "<br>" +
              i18n.get("Would you like to reload the current record?"),
          });
          if (confirmed) {
            onConfirm();
          }
        }
      },
      [dataStore, formAtom, info, onConfirm, tab],
    ),
  );

  const handleTabClick = useCallback(
    (e: Event) => {
      if (e instanceof CustomEvent && e.detail === tab.id) {
        check();
      }
    },
    [check, tab.id],
  );

  useEffect(() => {
    document.addEventListener("tab:click", handleTabClick);
    return () => {
      document.removeEventListener("tab:click", handleTabClick);
    };
  }, [handleTabClick]);
}
