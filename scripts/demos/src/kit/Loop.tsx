import React from "react";

/*
 * Loop restart: the video ends on the full assembled frame and restarts on the
 * bare scaffold — terminal chrome, PR card — with every dynamic line animating
 * itself back in. Deliberately NO container-level fade here: each child already
 * rises on its own, so a wrapper fade only hid the scaffold and left frame 0
 * blank, which players and thumbnails happily use as the poster.
 */
export const Loop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 48,
      width: "100%",
    }}
  >
    {children}
  </div>
);
