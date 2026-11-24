import { configure } from "@testing-library/react";

// Dom testing baseline: wait for state; never assume rendering is synchronous.
// Default asyncUtilTimeout is increased to 10s so slow runs or delayed adapters don't race the UI.
configure({ asyncUtilTimeout: 10_000 });
