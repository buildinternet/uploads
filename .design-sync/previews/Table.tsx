import "./canvas.module.css";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@uploads/ui";

const files = [
  { name: "console-after.png", size: "2.3 KB", type: "png", visibility: "public" },
  { name: "settings-savebar.png", size: "1.9 KB", type: "png", visibility: "public" },
  { name: "checkout-flow.gif", size: "412 KB", type: "gif", visibility: "unlisted" },
  { name: "release-notes.pdf", size: "88 KB", type: "pdf", visibility: "public" },
];

export function FileListing() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Visibility</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((f) => (
          <TableRow key={f.name}>
            <TableCell>{f.name}</TableCell>
            <TableCell>{f.size}</TableCell>
            <TableCell>{f.type}</TableCell>
            <TableCell>{f.visibility}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function WithCaption() {
  return (
    <Table>
      <TableCaption>4 files · updated 5 minutes ago</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Size</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.slice(0, 2).map((f) => (
          <TableRow key={f.name}>
            <TableCell>{f.name}</TableCell>
            <TableCell>{f.size}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
