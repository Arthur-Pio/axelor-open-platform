import { useCallback, useMemo } from "react";

import { Select, SelectValue } from "@/components/select";
import { useAsync } from "@/hooks/use-async";
import { request } from "@/services/client/client";
import { i18n } from "@/services/client/i18n";

import { FieldControl, FieldProps } from "../../builder";
import { useInput } from "../../builder/hooks";
import { ViewerInput } from "../string/viewer";

type ThemeOption = {
  name: string;
  title: string;
  id?: string;
};

export function ThemeSelect(props: FieldProps<string>) {
  const { data: userThemes = [] } = useAsync(async () => {
    const res = await request({
      url: "ws/app/themes",
    });
    if (res.ok) {
      return await res.json();
    }
    return Promise.reject();
  }, []);

  const themes = useMemo<ThemeOption[]>(() => {
    return [
      ...userThemes,
      {
        name: "light",
        title: i18n.get("Light"),
      },
      {
        name: "dark",
        title: i18n.get("Dark"),
      },
      {
        name: "auto",
        title: i18n.get("Auto"),
      },
    ];
  }, [userThemes]);

  const { schema, readonly, valueAtom } = props;
  const { placeholder } = schema;

  const { value, setValue } = useInput(valueAtom, { defaultValue: "", schema });

  const text = useMemo(
    () => themes.find((x) => x.id === value || x.name === value)?.title ?? "",
    [themes, value],
  );
  const selected = useMemo(
    () => themes.find((x) => x.id === value || x.name === value) ?? null,
    [themes, value],
  );

  const handleChange = useCallback(
    (option: SelectValue<ThemeOption, false>) => {
      setValue(option?.id ?? option?.name ?? null, true);
    },
    [setValue],
  );

  return (
    <FieldControl {...props}>
      {readonly && <ViewerInput name={schema.name} value={text} />}
      {readonly || (
        <Select
          autoComplete={false}
          placeholder={placeholder}
          onChange={handleChange}
          value={selected}
          options={themes}
          optionKey={(x) => x.id ?? x.name}
          optionLabel={(x) => x.title}
          optionEqual={(x, y) => x.id === y.id || x.name === y.name}
        />
      )}
    </FieldControl>
  );
}
