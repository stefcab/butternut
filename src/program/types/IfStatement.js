import Node from '../Node.js';
import { UNKNOWN } from '../../utils/sentinels.js';

const invalidChars = /[a-zA-Z$_0-9/]/;

// TODO this whole thing is kinda messy... refactor it

function endsWithCurlyBraceOrSemicolon ( node ) {
	return (
		node.type === 'BlockStatement' ||
		node.type === 'TryStatement' ||
		node.type === 'EmptyStatement'
	);
}

export default class IfStatement extends Node {
	canSequentialise () {
		const testValue = this.test.getValue();

		if ( testValue === UNKNOWN ) {
			return this.consequent.canSequentialise() && ( !this.alternate || this.alternate.canSequentialise() );
		}

		if ( testValue ) {
			return this.consequent.canSequentialise();
		}

		return this.alternate ? this.alternate.canSequentialise() : false;
	}

	getLeftHandSide () {
		const testValue = this.test.getValue();

		if ( testValue === UNKNOWN ) {
			if ( this.canSequentialise() ) return ( this.inverted ? this.test.argument : this.test ).getLeftHandSide();
			return this;
		}

		if ( testValue ) return this.consequent.getLeftHandSide();
		return this.alternate.getLeftHandSide();
	}

	getRightHandSide () {
		const testValue = this.test.getValue();

		if ( testValue === UNKNOWN ) {
			if ( this.canSequentialise() ) return ( this.alternate ? ( this.inverted ? this.consequent : this.alternate ) : this.consequent ).getRightHandSide();
			return ( this.alternate || this.consequent ).getRightHandSide();
		}

		if ( testValue ) return this.consequent.getRightHandSide();
		return this.alternate.getRightHandSide();
	}

	initialise ( scope ) {
		this.skip = false; // TODO skip if known to be safe

		const testValue = this.test.getValue();

		if ( testValue === UNKNOWN ) {
			// initialise everything
			this.test.initialise( scope );
			this.consequent.initialise( scope );
			if ( this.alternate ) this.alternate.initialise( scope );
		}

		else if ( testValue ) { // if ( true ) {...}
			this.consequent.initialise( scope );

			if ( this.alternate && this.alternate.type === 'BlockStatement' ) {
				this.alternate.scope.varDeclarations.forEach( name => {
					scope.functionScope.hoistedVars.add( name );
				});
			}
		}

		else { // if ( false ) {...}
			if ( this.alternate ) {
				this.alternate.initialise( scope );
			} else {
				this.skip = true;
			}

			if ( this.consequent.type === 'BlockStatement' ) {
				this.consequent.scope.varDeclarations.forEach( name => {
					scope.functionScope.hoistedVars.add( name );
				});
			}
		}

		this.inverted = this.test.type === 'UnaryExpression' && this.test.operator === '!';
	}

	minify ( code ) {
		const testValue = this.test.getValue();

		if ( testValue !== UNKNOWN ) {
			if ( testValue ) { // if ( true ) {...}
				if ( this.alternate ) {
					// TODO handle var declarations in alternate
					code.remove( this.consequent.end, this.end );
				}

				code.remove( this.start, this.consequent.start );
				this.consequent.minify( code );
			} else { // if ( false ) {...}
				// we know there's an alternate, otherwise we wouldn't be here
				this.alternate.minify( code );
				code.remove( this.start, this.alternate.start );
			}

			return;
		}

		this.test.minify( code );

		// if we're rewriting as &&, test must be higher precedence than 6
		// to avoid being wrapped in parens. If ternary, 4
		const targetPrecedence = this.alternate ? 4 : this.inverted ? 5 : 6;

		const shouldParenthesiseTest = (
			this.test.getPrecedence() < targetPrecedence ||
			this.test.getLeftHandSide().type === 'ObjectExpression' ||
			this.test.getRightHandSide().type === 'ObjectExpression'
		);

		// TODO what if nodes in the consequent are skipped...
		const shouldParenthesiseConsequent = this.consequent.type === 'BlockStatement' ?
			( this.consequent.body.length === 1 ? this.consequent.body[0].getPrecedence() < targetPrecedence : true ) :
			this.consequent.getPrecedence() < targetPrecedence;

		// special case – empty consequent
		if ( this.consequent.isEmpty() ) {
			const canRemoveTest = this.test.type === 'Identifier' || this.test.getValue() !== UNKNOWN; // TODO can this ever happen?

			if ( this.alternate ) {
				this.alternate.minify( code );

				if ( this.alternate.type === 'BlockStatement' && this.alternate.body.length === 0 ) {
					if ( canRemoveTest ) {
						code.remove( this.start, this.end );
						this.removed = true;
					}
				} else if ( this.alternate.canSequentialise() ) {
					let alternatePrecedence;
					if ( this.alternate.type === 'IfStatement' ) {
						alternatePrecedence = this.alternate.alternate ?
							4 : // will rewrite as ternary
							5;
					} else if ( this.alternate.type === 'BlockStatement' ) {
						alternatePrecedence = this.alternate.body.length === 1 ?
							this.alternate.body[0].getPrecedence() :
							0; // sequence
					} else {
						alternatePrecedence = 0; // err on side of caution
					}

					const shouldParenthesiseAlternate = alternatePrecedence < ( this.inverted ? 6 : 5 );
					if ( shouldParenthesiseAlternate ) {
						code.prependRight( this.alternate.start, '(' ).appendLeft( this.alternate.end, ')' );
					}

					if ( this.inverted ) code.remove( this.test.start, this.test.argument.start );
					code.remove( this.start, this.test.start );
					code.overwrite( this.test.end, this.alternate.start, this.inverted ? '&&' : '||' );
				} else {
					if ( this.inverted ) {
						code.overwrite( this.start + 2, this.test.argument.start, '(' );
					} else {
						code.overwrite( this.start + 2, this.test.start, '(!' );
					}

					code.overwrite( this.test.end, this.alternate.start, ')' );
				}
			} else {
				// TODO is `removed` still used?
				if ( canRemoveTest ) {
					code.remove( this.start, this.end );
					this.removed = true;
				} else {
					code.remove( this.start, this.test.start );
					code.remove( this.test.end, this.consequent.end );
				}
			}

			return;
		}

		// special case - empty alternate
		if ( this.alternate && this.alternate.isEmpty() ) {
			// don't minify alternate
			this.consequent.minify( code );
			code.remove( this.consequent.end, this.end );

			if ( this.consequent.canSequentialise() ) {
				code.overwrite( this.start, ( this.inverted ? this.test.argument.start : this.test.start ), shouldParenthesiseTest ? '(' : '' );

				let replacement = shouldParenthesiseTest ? ')' : '';
				replacement += this.inverted ? '||' : '&&';
				if ( shouldParenthesiseConsequent ) replacement += '(';

				code.overwrite( this.test.end, this.consequent.start, replacement );

				if ( shouldParenthesiseConsequent ) code.appendRight( this.consequent.end, ')' );
			}

			else {
				if ( this.test.start > this.start + 3 ) code.overwrite( this.start, this.test.start, 'if(' );

				if ( this.consequent.start > this.test.end + 1 ) code.overwrite( this.test.end, this.consequent.start, ')' );
				if ( this.end > this.consequent.end + 1 ) code.remove( this.consequent.end, this.end - 1 );
			}

			return;
		}

		this.consequent.minify( code );
		if ( this.alternate ) this.alternate.minify( code );

		if ( this.canSequentialise() ) {
			if ( this.inverted ) code.remove( this.test.start, this.test.start + 1 );

			if ( this.alternate ) {
				this.rewriteAsTernaryExpression( code, shouldParenthesiseTest, shouldParenthesiseConsequent );
			} else {
				this.rewriteAsLogicalExpression( code, shouldParenthesiseTest, shouldParenthesiseConsequent );
			}
		}

		else {
			if ( this.test.start > this.start + 3 ) code.overwrite( this.start + 2, this.test.start, '(' );
			if ( this.consequent.start > this.test.end + 1 ) code.overwrite( this.test.end, this.consequent.start, ')' );

			if ( this.alternate ) {
				const lastNodeOfConsequent = this.consequent.getRightHandSide();
				const firstNodeOfAlternate = this.alternate.getLeftHandSide();

				let gap = ( endsWithCurlyBraceOrSemicolon( lastNodeOfConsequent ) ? '' : ';' ) + 'else';
				if ( invalidChars.test( code.original[ firstNodeOfAlternate.start ] ) ) gap += ' ';

				let c = this.consequent.end;
				while ( code.original[ c - 1 ] === ';' ) c -= 1;

				code.overwrite( c, this.alternate.start, gap );
			}
		}
	}

	preventsCollapsedReturns ( returnStatements ) {
		// TODO make this a method of nodes
		if ( this.consequent.type === 'BlockStatement' ) {
			for ( let statement of this.consequent.body ) {
				if ( statement.skip ) continue;
				if ( statement.preventsCollapsedReturns( returnStatements ) ) return true;
			}
		} else {
			if ( this.consequent.preventsCollapsedReturns( returnStatements ) ) return true;
		}

		if ( this.alternate ) {
			if ( this.alternate.type === 'ExpressionStatement' ) return false;
			if ( this.alternate.type === 'ReturnStatement' ) return returnStatements.push( this.alternate ), false;
			if ( this.alternate.type === 'IfStatement' ) return this.alternate.preventsCollapsedReturns( returnStatements );

			if ( this.alternate.type === 'BlockStatement' ) {
				for ( let statement of this.alternate.body ) {
					if ( statement.skip ) continue;
					if ( statement.preventsCollapsedReturns( returnStatements ) ) return true;
				}
			}

			else {
				if ( this.alternate.preventsCollapsedReturns( returnStatements ) ) return true;
			}
		}
	}

	rewriteAsLogicalExpression ( code, shouldParenthesiseTest, shouldParenthesiseConsequent ) {
		code.remove( this.start, this.test.start );

		if ( shouldParenthesiseTest ) {
			code.prependRight( this.test.getLeftHandSide().start, '(' );
			code.appendLeft( this.test.getRightHandSide().end, ')' );
		}

		if ( shouldParenthesiseConsequent ) {
			code.prependRight( this.consequent.getLeftHandSide().start, '(' );
			code.appendLeft( this.consequent.getRightHandSide().end, ')' );
		}

		code.overwrite( this.test.end, this.consequent.start, this.inverted ? '||' : '&&' );
	}

	rewriteAsTernaryExpression ( code, shouldParenthesiseTest, shouldParenthesiseConsequent ) {
		this.rewriteAsSequence = true;

		let shouldParenthesiseAlternate = false;
		// TODO simplify this
		if ( this.alternate.type === 'IfStatement' ) {
			shouldParenthesiseAlternate = false;
		} else if ( this.alternate.type === 'BlockStatement' ) {
			shouldParenthesiseAlternate = this.alternate.body.length > 1 || this.alternate.body[0].getPrecedence() < 4;
		} else {
			shouldParenthesiseAlternate = this.alternate.getPrecedence() < 4;
		}

		// if ( this.alternate.type === 'BlockStatement' ) {
		// 	if ( this.alternate.body.length > 1 ) {
		// 		shouldParenthesiseAlternate = true;
		// 	} else if ( this.alternate.body[0].type !== 'IfStatement' ) {
		// 		shouldParenthesiseAlternate = this.alternate.body[0].getPrecedence() < 4;
		// 	}
		// }

		// const shouldParenthesiseAlternate = this.alternate.type === 'BlockStatement' ?
		// 	( this.alternate.body.length === 1 ? getPrecedence( this.alternate.body[0] ) < 4 : true ) :
		// 	false; // TODO <-- is this right? Ternaries are r-to-l, so... maybe?

		code.overwrite( this.start, this.test.start, shouldParenthesiseTest ? '(' : '' );

		let replacement = shouldParenthesiseTest ? ')?' : '?';
		if ( this.inverted && shouldParenthesiseAlternate ) replacement += '(';
		if ( !this.inverted && shouldParenthesiseConsequent ) replacement += '(';

		code.overwrite( this.test.end, this.consequent.start, replacement );

		let consequentEnd = this.consequent.end;
		while ( code.original[ consequentEnd - 1 ] === ';' ) consequentEnd -= 1;

		let alternateEnd = this.alternate.end;
		while ( code.original[ alternateEnd - 1 ] === ';' ) alternateEnd -= 1;

		code.remove( consequentEnd, this.alternate.start );

		if ( this.inverted ) {
			let alternateEnd = this.alternate.end;
			while ( code.original[ alternateEnd - 1 ] === ';' ) alternateEnd -= 1;

			let consequentEnd = this.consequent.end;
			while ( code.original[ consequentEnd - 1 ] === ';' ) consequentEnd -= 1;

			code.move( this.alternate.start, alternateEnd, this.consequent.start );
			code.move( this.consequent.start, consequentEnd, alternateEnd );

			let replacement = shouldParenthesiseAlternate ? '):' : ':';
			if ( shouldParenthesiseConsequent ) replacement += '(';

			code.prependRight( this.consequent.start, replacement );

			if ( shouldParenthesiseConsequent ) code.appendLeft( consequentEnd, ')' );
		} else {
			let replacement = shouldParenthesiseConsequent ? '):' : ':';
			if ( shouldParenthesiseAlternate ) replacement += '(';

			code.appendLeft( this.consequent.end, replacement );

			let c = this.alternate.end;
			while ( code.original[ c - 1 ] === ';' ) c -= 1;
			if ( shouldParenthesiseAlternate ) code.appendLeft( c, ')' );
		}
	}
}
