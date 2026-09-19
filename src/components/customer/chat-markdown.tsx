import { Fragment } from "react";
import {
  parseChatMarkdown,
  type ChatBlock,
  type ChatInline,
} from "@/lib/ai/chat-format";

/**
 * Renders a waiter reply from the parsed tree in src/lib/ai/chat-format.ts.
 *
 * Every node becomes an ordinary React element with string children, so
 * React's escaping applies throughout — there is no dangerouslySetInnerHTML
 * and no path from model output to markup or to a link (spec section 37).
 */
function Inlines({ nodes }: { nodes: ChatInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <Fragment key={index}>{node.text}</Fragment>;
          case "strong":
            return (
              <strong key={index} className="font-semibold">
                <Inlines nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.children} />
              </em>
            );
          case "code":
            return (
              <code
                key={index}
                className="bg-background/70 rounded px-1 py-0.5 font-mono text-[0.85em]"
              >
                {node.text}
              </code>
            );
        }
      })}
    </>
  );
}

function Block({ block }: { block: ChatBlock }) {
  switch (block.type) {
    case "heading":
      return (
        <p className="font-semibold">
          <Inlines nodes={block.content} />
        </p>
      );
    case "paragraph":
      return (
        <p>
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 && <br />}
              <Inlines nodes={line} />
            </Fragment>
          ))}
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          className={
            block.ordered
              ? "list-decimal space-y-1 pl-5"
              : "list-disc space-y-1 pl-5 marker:text-current/50"
          }
        >
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <div className="bg-background/60 -mx-1 overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[0.8125rem]">
            <thead>
              <tr className="border-b">
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    scope="col"
                    className="px-2.5 py-1.5 font-semibold"
                  >
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b last:border-b-0">
                  {row.map((cell, index) => (
                    <td key={index} className="px-2.5 py-1.5 align-top">
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function ChatMarkdown({ source }: { source: string }) {
  const blocks = parseChatMarkdown(source);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
