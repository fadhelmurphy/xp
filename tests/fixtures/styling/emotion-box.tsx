/** @jsxImportSource @emotion/react */
import styled from "@emotion/styled";
import { css } from "@emotion/react";

const Box = styled.div`
  padding: 12px;
  background: hotpink;
`;

export default function EmotionBox({ label = "emotion" }: { label?: string }) {
  return (
    <Box data-testid="box">
      <span css={css`font-weight: bold;`}>{label}</span>
    </Box>
  );
}
