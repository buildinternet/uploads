/**
 * Design-sync barrel — NOT part of the public API.
 *
 * /design-sync bundles this entry into the Claude Design project's
 * `window.UploadsUI` global, so the design agent can build with every
 * component in the kit. App code keeps importing via the subpath exports
 * (`@uploads/ui/components/<name>`); nothing should import this file.
 */
export * from "./components/ui/accordion";
export * from "./components/ui/alert-dialog";
export * from "./components/ui/badge";
export * from "./components/ui/button";
export * from "./components/ui/checkbox";
export * from "./components/ui/combobox";
export * from "./components/ui/dialog";
export * from "./components/ui/dropdown-menu";
export * from "./components/ui/empty";
export * from "./components/ui/input";
export * from "./components/ui/input-group";
export * from "./components/ui/kbd";
export * from "./components/ui/label";
export * from "./components/ui/popover";
export * from "./components/ui/select";
export * from "./components/ui/separator";
export * from "./components/ui/sheet";
export * from "./components/ui/sidebar";
export * from "./components/ui/skeleton";
export * from "./components/ui/switch";
export * from "./components/ui/table";
export * from "./components/ui/tabs";
export * from "./components/ui/textarea";
export * from "./components/ui/tooltip";
export { cn } from "./lib/utils";
