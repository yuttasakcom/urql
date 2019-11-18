import { pipe, tap, map } from 'wonka';
import { Exchange, Operation } from '../types';
import {
  DocumentNode,
  buildClientSchema,
  visitWithTypeInfo,
  TypeInfo,
  FragmentDefinitionNode,
  GraphQLNonNull,
  GraphQLNullableType,
  print,
} from 'graphql';
import { visit } from 'graphql';

type TypeFragmentMap<T extends string = string> = Record<string, string[]> & {
  _fragments?: FragmentDefinitionNode[];
};

interface ExchangeArgs {
  schema: any;
}

/** An exchange for auto-populating mutations with a required response body. */
export const mutateBodyExchange = ({ schema }: ExchangeArgs): Exchange => ({
  forward,
}) => {
  let fragmentMap: TypeFragmentMap = { _fragments: [] };

  const handleIncomingMutation = (op: Operation) => {
    if (op.operationName !== 'mutation') {
      return op;
    }

    return {
      ...op,
      query: addFragmentsToQuery({ schema, fragmentMap, query: op.query }),
    };
  };

  const handleIncomingQuery = (op: Operation) => {
    if (op.operationName !== 'query') {
      return;
    }

    fragmentMap = makeFragmentsFromQuery({
      schema,
      query: op.query,
      fragmentMap: fragmentMap,
    });

    console.log(fragmentMap);
  };

  return ops$ => {
    return pipe(
      ops$,
      tap(handleIncomingQuery),
      map(handleIncomingMutation),
      forward
    );
  };
};

interface MakeFragmentsFromQueryArg {
  schema: any;
  query: DocumentNode;
  fragmentMap: TypeFragmentMap;
}

/** Creates fragments object from query */
export const makeFragmentsFromQuery = ({
  schema,
  query,
  fragmentMap,
}: MakeFragmentsFromQueryArg) => {
  let f = fragmentMap;
  const typeInfo = new TypeInfo(buildClientSchema(schema));

  visit(
    query,
    visitWithTypeInfo(typeInfo, {
      Field: (node, key, parent, path) => {
        if (!node.selectionSet) {
          return undefined;
        }

        // @ts-ignore
        const t = typeInfo.getType().ofType;

        if (!t) {
          return undefined;
        }

        // @ts-ignore
        f = {
          ...f,
          [t]: [...(f[t] || []), node.selectionSet],
        };
      },
      FragmentDefinition: node => {
        // @ts-ignore
        f = {
          ...f,
          _fragments: [...(f._fragments || []), node],
        };
      },
    })
  );

  return f;
};

interface AddFragmentsToQuery {
  schema: any;
  query: DocumentNode;
  fragmentMap: TypeFragmentMap;
}

export const addFragmentsToQuery = ({
  schema,
  query,
  fragmentMap,
}: AddFragmentsToQuery) => {
  const typeInfo = new TypeInfo(buildClientSchema(schema));

  const v = visit(
    query,
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter: node => {
          const directive =
            node.directives &&
            node.directives.find(d => d.name.value === 'populate');

          if (!directive) {
            return;
          }

          console.log(schema);
          console.log(typeInfo.getType());
          const t = typeInfo.getType() as any;
          const type = t.ofType || t.toString();

          console.log(type, fragmentMap);

          return {
            ...node,
            directives: (node.directives as any).filter(
              d => d.name.value !== 'populate'
            ),
            selectionSet: {
              kind: 'SelectionSet',
              selections: (fragmentMap[type] || []).map(selectionSet => ({
                kind: 'InlineFragment',
                typeCondition: {
                  kind: 'NamedType',
                  name: { kind: 'Name', value: type },
                },
                selectionSet,
              })),
            },
          };
        },
      },
      Document: {
        leave: node => {
          return {
            ...node,
            definitions: [
              ...node.definitions,
              ...(fragmentMap._fragments || []),
            ],
          };
        },
      },
    })
  );

  console.log(print(v));

  return v;
};