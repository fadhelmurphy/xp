/** @jsxImportSource react */
import styled from "styled-components";

const Box = styled.div`
  padding: 12px;
  background: teal;
`;

export default function StyledBox({ label = "styled" }: { label?: string }) {
  return <Box data-testid="box">{label}</Box>;
}
