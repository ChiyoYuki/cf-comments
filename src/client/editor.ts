import type { CommentSyntax } from "../shared/types.ts";
import { element } from "./content.ts";

export function syntaxPicker(
  label: string,
  initial: CommentSyntax = "gfm",
  modes: readonly CommentSyntax[] = ["gfm", "mfm"],
) {
  const group = element("fieldset", "cc-segments");
  group.append(element("legend", "cc-sr-only", label));
  for (const mode of modes) {
    const choice = element("label");
    const input = element("input", "cc-sr-only");
    input.type = "radio";
    input.name = "syntax";
    input.value = mode;
    input.checked = initial === mode;
    choice.append(input, element("span", "", mode.toUpperCase()));
    group.append(choice);
  }
  return group;
}

export function syntaxValue(fields: FormData): CommentSyntax {
  return fields.get("syntax") === "mfm" ? "mfm" : "gfm";
}

export function field(
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
) {
  const wrapper = element("label", "cc-field");
  wrapper.append(element("span", "", label), input);
  return wrapper;
}

export function textInput(name: string, type: string, maxLength: number) {
  const input = element("input");
  input.name = name;
  input.type = type;
  input.maxLength = maxLength;
  return input;
}
